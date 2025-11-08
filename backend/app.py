"""Application entrypoint for the MotionMonitor backend service."""
from __future__ import annotations

import os
from datetime import datetime
from typing import Any, Dict

from flask import Flask, jsonify, request
from flask_socketio import SocketIO, emit

app = Flask(__name__)
app.config["SECRET_KEY"] = "motion-monitor-backend"

# Use eventlet for compatibility with Flask-SocketIO on Windows/Python.
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="eventlet")


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
    """Notify the newly connected WebSocket client."""
    emit("connected", {"message": "Connected to MotionMonitor stream."})


@socketio.on("disconnect", namespace="/stream")
def on_disconnect() -> None:
    """Handle client disconnects."""
    app.logger.info("WebSocket client disconnected")


@socketio.on("sensor_update", namespace="/stream")
def on_sensor_update(data: Dict[str, Any]) -> None:
    """Broadcast live sensor updates to all subscribed clients."""
    if not isinstance(data, dict):
        emit("error", {"message": "Expected dict payload."})
        return

    data.setdefault("receivedAt", _current_timestamp())
    emit("sensor_update", data, broadcast=True, include_self=False)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "3000"))
    socketio.run(app, host="0.0.0.0", port=port, allow_unsafe_werkzeug=True)
