# MotionMonitor

MotionMonitor is a React Native application that reads motion sensor data from a handset or wearable and helps prototype the data pipeline for a remote monitoring platform. It streams live accelerometer and gyroscope values using the [`react-native-sensors`](https://github.com/react-native-sensors/react-native-sensors) package and can post snapshots to a configurable HTTP endpoint.

## Features

- Live accelerometer and gyroscope telemetry at a 100 ms sampling interval (tweakable in code).
- Start/stop controls to manage sensor subscriptions and conserve battery.
- Configurable endpoint field with a one-tap JSON payload sender for rapid backend testing.
- Built-in Socket.IO client that streams readings to a configurable WebSocket namespace.
- Rolling trend charts for accelerometer and gyroscope axes plus magnitude statistics, mirroring the Jupyter analysis notebook.
- Clinician dashboard mode that visualizes the last 50 streamed samples coming from the backend feed for live demos.
- Fall detection alert loop powered by a Flask back end with CSV logging for model development.
- Light and dark mode aware UI with last-updated timestamps for each sensor channel.

## Prerequisites

Ensure the React Native development environment is installed by following the official [environment setup guide](https://reactnative.dev/docs/set-up-your-environment). The project uses the React Native CLI (bare workflow) and expects the Android SDK (for Android builds) and Xcode with CocoaPods (for iOS builds).

## Installation

Install JavaScript dependencies:

```sh
npm install
```

For iOS only (first run or after changing native dependencies):

```sh
cd ios
bundle install
bundle exec pod install
cd ..
```

## Running the App

Start Metro in one terminal window:

```sh
npm start
```

In another terminal, launch the native app:

```sh
# Android
npm run android

# iOS
npm run ios
```

## Using the Sensor Dashboard

1. Launch the app on a device or simulator that has motion sensors available.
2. Tap **Start** to begin streaming; tap **Stop** to release sensor subscriptions and zero out the readings.
3. Enter an HTTP endpoint in the **Send Snapshot** field (for example, a local tunnel or test API).
4. Select **Send Snapshot** to POST the most recent accelerometer and gyroscope readings as JSON.
5. Configure the WebSocket URL (defaults to `http://localhost:3000/stream`) to stream live readings to your Socket.IO backend.
6. Watch the accelerometer and gyroscope charts fill in with live data; aggregated min/mean/max stats update as samples arrive.
7. Scroll to **Clinician Dashboard** to view the last 50 streamed magnitudes coming back from the server in real time.

> The default endpoint (`http://localhost:3000/api/sensors`) is a placeholder; replace it with your backend URL. On physical devices, ensure the endpoint is reachable over the network.

## Platform Notes

- **iOS**: `NSMotionUsageDescription` is defined in `ios/MotionMonitor/Info.plist`. Update the message if your compliance team requires specific wording.
- **Android**: No additional runtime permissions are required for accelerometer or gyroscope access. If you later read heart-rate or body sensors, add `android.permission.BODY_SENSORS` to `android/app/src/main/AndroidManifest.xml`.

## Backend Service

A companion Flask + Socket.IO backend lives in the `backend/` folder. It exposes:

- `POST /api/sensors` for manual snapshots (mirrors the app's **Send Snapshot** button).
- Socket.IO namespace `/stream` for live `sensor_update` events.
- `GET /health` for readiness checks.
- `GET /api/gait_analysis` to compute cadence (steps per minute) from the recorded CSV using FFT.

Quick start (from `backend/`):

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python app.py
```

The server listens on `http://localhost:3000` by default, logs every `sensor_update` event to `backend/sensor_data.csv`, and forwards live events to any connected dashboard or tooling. A basic freefall/impact detector emits `fall_detected` events back to the originating client as a starting point for real-time alerting.

## Next Steps

- Extend the snapshot sender into a background streaming service or WebSocket client.
- Integrate heart-rate or other wearable sensors as hardware becomes available.
- Persist historical readings locally for offline review and analytics.
