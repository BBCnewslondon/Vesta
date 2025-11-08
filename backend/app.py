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

app = Flask(__name__)
app.config["SECRET_KEY"] = "motion-monitor-backend"

# Use eventlet for compatibility with Flask-SocketIO on Windows/Python.
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="eventlet")

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
FREEFALL_THRESHOLD = 2.0  # m/s^2
IMPACT_THRESHOLD = 30.0  # m/s^2
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
            socketio.emit(
                "fall_detected",
                {
                    "message": "Fall detected",
                    "timestamp": _current_timestamp(),
                    "acceleration": acc_mag,
                },
                to=sid,
                namespace="/stream",
            )
            app.logger.warning("Fall detected for connection %s", sid)
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

    emit("sensor_update", data, broadcast=True, include_self=False)


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
