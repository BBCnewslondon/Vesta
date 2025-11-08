"""Application entrypoint for the MotionMonitor backend service."""
from __future__ import annotations

import atexit
import csv
import os
from datetime import datetime
from pathlib import Path
from typing import Any, Dict

from flask import Flask, jsonify, request
from flask_socketio import SocketIO, emit
from twilio.rest import Client

app = Flask(__name__)
app.config["SECRET_KEY"] = "motion-monitor-backend"

# Use eventlet for compatibility with Flask-SocketIO on Windows/Python.
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="eventlet")

# --- Twilio setup for SMS notifications ---------------------------------------------
TWILIO_ACCOUNT_SID = os.environ.get("TWILIO_ACCOUNT_SID")
TWILIO_AUTH_TOKEN = os.environ.get("TWILIO_AUTH_TOKEN")
TWILIO_PHONE_NUMBER = os.environ.get("TWILIO_PHONE_NUMBER")
RECIPIENT_PHONE_NUMBER = "+440788663048"

twilio_client = None
if TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN and TWILIO_PHONE_NUMBER:
    twilio_client = Client(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
    app.logger.info("Twilio client initialized.")
else:
    app.logger.warning(
        "Twilio credentials not found in environment variables. SMS notifications will be disabled."
    )


def send_sms_notification(message: str) -> None:
    """Send an SMS notification using Twilio."""
    if not twilio_client:
        app.logger.warning("Twilio client not initialized. Cannot send SMS.")
        return

    try:
        twilio_client.messages.create(
            body=message,
            from_=TWILIO_PHONE_NUMBER,
            to=RECIPIENT_PHONE_NUMBER,
        )
        app.logger.info("SMS notification sent to %s", RECIPIENT_PHONE_NUMBER)
    except Exception as e:
        app.logger.error("Failed to send SMS: %s", e)


# --- Persistent data logging setup ----------------------------------------------------
DATA_FILE = Path(__file__).with_name("sensor_data.csv")

if not DATA_FILE.exists():
    with DATA_FILE.open("x", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(
            [
                "server_timestamp_utc",
                "client_timestamp_ms",
                "acc_x",
                "acc_y",
                "acc_z",
                "gyro_x",
                "gyro_y",
                "gyro_z",
            ]
        )

data_file_handle = DATA_FILE.open("a", newline="")
data_writer = csv.writer(data_file_handle)


@atexit.register
def _close_data_file() -> None:
    data_file_handle.close()


# --- Fall detection state -------------------------------------------------------------
FREEFALL_THRESHOLD = 5.0  # m/s^2
IMPACT_THRESHOLD = 15.0  # m/s^2
FALL_TIME_WINDOW_MS = 1_000  # ms

user_state: Dict[str, Dict[str, Any]] = {}


def _coerce_float(value: Any, fallback: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return fallback


def _coerce_timestamp_ms(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return datetime.utcnow().timestamp() * 1000.0


def _check_for_fall(sid: str, acc_x: Any, acc_y: Any, acc_z: Any, timestamp_ms: Any) -> None:
    if sid not in user_state:
        return

    state = user_state[sid]
    acc_x_f = _coerce_float(acc_x)
    acc_y_f = _coerce_float(acc_y)
    acc_z_f = _coerce_float(acc_z)
    timestamp_value = _coerce_timestamp_ms(timestamp_ms)

    acc_mag = (acc_x_f**2 + acc_y_f**2 + acc_z_f**2) ** 0.5

    if state.get("in_freefall"):
        elapsed = timestamp_value - state.get("freefall_time", 0.0)
        if acc_mag > IMPACT_THRESHOLD and elapsed < FALL_TIME_WINDOW_MS:
            fall_time = _current_timestamp()
            fall_message = f"Fall detected at {fall_time} with impact acceleration of {acc_mag:.2f} m/s^2."
            socketio.emit(
                "fall_detected",
                {
                    "message": "Fall detected",
                    "timestamp": fall_time,
                    "acceleration": acc_mag,
                },
                to=sid,
                namespace="/stream",
            )
            app.logger.warning("Fall detected for connection %s", sid)
            send_sms_notification(fall_message)
            state["in_freefall"] = False
        elif elapsed >= FALL_TIME_WINDOW_MS:
            state["in_freefall"] = False

    if acc_mag < FREEFALL_THRESHOLD:
        state["in_freefall"] = True
        state["freefall_time"] = timestamp_value


def _current_timestamp() -> str:
    """Return an ISO 8601 UTC timestamp."""
    return datetime.utcnow().isoformat(timespec="milliseconds") + "Z"


@app.get("/health")
def health() -> Any:
    """Simple health endpoint for monitoring and readiness checks."""
    return jsonify(status="ok", timestamp=_current_timestamp())


@app.post("/api/sensors")
def sensor_snapshot() -> Any:
    """Accept a one-off sensor snapshot payload via HTTP."""
    payload: Dict[str, Any] | None = request.get_json(silent=True)
    if payload is None:
        return jsonify(message="Invalid or missing JSON body."), 400

    payload.setdefault("receivedAt", _current_timestamp())
    socketio.emit("sensor_snapshot", payload, namespace="/stream")
    return jsonify(message="Snapshot received."), 200


@socketio.on("connect", namespace="/stream")
def on_connect() -> None:
    """Notify the newly connected WebSocket client and initialize state."""
    emit("connected", {"message": "Connected to MotionMonitor stream."})
    user_state[request.sid] = {"in_freefall": False, "freefall_time": 0.0}


@socketio.on("disconnect", namespace="/stream")
def on_disconnect() -> None:
    """Handle client disconnects."""
    app.logger.info("WebSocket client disconnected")
    user_state.pop(request.sid, None)


@socketio.on("sensor_update", namespace="/stream")
def on_sensor_update(data: Dict[str, Any]) -> None:
    """Broadcast live sensor updates to all subscribed clients and log them."""
    if not isinstance(data, dict):
        emit("error", {"message": "Expected dict payload."})
        return

    data.setdefault("receivedAt", _current_timestamp())

    acc = data.get("accelerometer", {}) or {}
    gyro = data.get("gyroscope", {}) or {}
    timestamp_ms = data.get("timestamp")

    try:
        data_writer.writerow(
            [
                data["receivedAt"],
                timestamp_ms,
                acc.get("x"),
                acc.get("y"),
                acc.get("z"),
                gyro.get("x"),
                gyro.get("y"),
                gyro.get("z"),
            ]
        )
        data_file_handle.flush()
    except Exception as error:  # pragma: no cover
        app.logger.error("Error writing to CSV: %s", error)

    try:
        _check_for_fall(
            request.sid,
            acc.get("x"),
            acc.get("y"),
            acc.get("z"),
            timestamp_ms,
        )
    except Exception as error:  # pragma: no cover
        app.logger.error("Error in fall detection: %s", error)

    emit("sensor_update", data, broadcast=True)


# --- Gait analysis -------------------------------------------------------------
def analyze_gait() -> dict | None:
    """Analyze gait from sensor data using FFT to compute cadence."""
    try:
        import numpy as np
        from scipy.fft import fft, fftfreq
    except ImportError:
        return None

    if not DATA_FILE.exists():
        return None

    rows = []
    with DATA_FILE.open("r", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            rows.append(row)

    if len(rows) < 2:
        return None

    # Parse timestamps
    timestamps = []
    for row in rows:
        try:
            ts = datetime.fromisoformat(row["server_timestamp_utc"])
            timestamps.append(ts)
        except (ValueError, TypeError):
            continue

    if len(timestamps) < 2:
        return None

    # Compute mean dt
    dts = [(timestamps[i + 1] - timestamps[i]).total_seconds() for i in range(len(timestamps) - 1)]
    dt = np.mean(dts)
    if dt <= 0 or np.isnan(dt):
        return None

    fs = 1 / dt

    # Get acceleration data
    try:
        acc_x = [float(row["acc_x"]) for row in rows]
        acc_y = [float(row["acc_y"]) for row in rows]
        acc_z = [float(row["acc_z"]) for row in rows]
    except (ValueError, KeyError):
        return None

    acc_mag = np.sqrt(np.array(acc_x) ** 2 + np.array(acc_y) ** 2 + np.array(acc_z) ** 2)

    N = len(acc_mag)
    yf = fft(acc_mag)
    xf = fftfreq(N, 1 / fs)

    positive_freqs = xf[xf > 0]
    magnitudes = np.abs(yf[xf > 0])

    if len(magnitudes) == 0:
        return None

    dominant_idx = np.argmax(magnitudes)
    dominant_freq = positive_freqs[dominant_idx]
    cadence = dominant_freq * 60

    return {
        "cadence": float(cadence),
        "dominant_frequency": float(dominant_freq),
        "sampling_frequency": float(fs),
        "data_points": N,
    }


@app.get("/api/gait_analysis")
def gait_analysis():
    """Endpoint to analyze gait from sensor data and return cadence."""
    result = analyze_gait()
    if result is None:
        return jsonify(error="Insufficient or invalid data for gait analysis"), 400
    return jsonify(result)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "3000"))
    try:
        socketio.run(
            app,
            host="0.0.0.0",
            port=port,
            allow_unsafe_werkzeug=True,
            log_output=True,
        )
    except Exception as error:  # pragma: no cover
        print(f"Backend failed to start: {error}", flush=True)
        raise
