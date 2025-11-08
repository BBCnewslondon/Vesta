# MotionMonitor Backend

A minimal Flask + Socket.IO backend that receives motion sensor snapshots over HTTP and consumes a WebSocket
stream for live telemetry.

## Features

- `/api/sensors` POST endpoint for the React Native app's snapshot button.
- `/stream` Socket.IO namespace that accepts `sensor_update` events and re-broadcasts them to connected clients.
- `/health` GET endpoint for readiness checks.

## Getting Started

1. **Create a virtual environment** (recommended):

   ```powershell
   python -m venv .venv
   .\.venv\Scripts\Activate.ps1
   ```

2. **Install dependencies**:

   ```powershell
   pip install -r requirements.txt
   ```

3. **Run the development server**:

   ```powershell
   python app.py
   ```

   The server listens on `http://localhost:3000` and exposes the Socket.IO WebSocket at `ws://localhost:3000/stream`.

## Testing with Socket.IO Client

You can verify the WebSocket endpoint quickly using the `socket.io-client` package or any Socket.IO compatible tooling:

```javascript
const { io } = require("socket.io-client");
const socket = io("http://localhost:3000/stream");

socket.on("connect", () => {
  console.log("connected", socket.id);
  socket.emit("sensor_update", {
    timestamp: Date.now(),
    accelerometer: { x: 0, y: 0, z: 9.81 },
    gyroscope: { x: 0, y: 0, z: 0 },
  });
});

socket.on("sensor_update", console.log);
```

## Environment Variables

- `PORT`: Override the default port (3000).
- `FLASK_ENV`: Set to `development` to enable auto reload.
