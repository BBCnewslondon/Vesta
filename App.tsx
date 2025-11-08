import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Button,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  useColorScheme,
  View,
} from 'react-native';
import {
  SafeAreaProvider,
  SafeAreaView,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';
import { io, Socket } from 'socket.io-client';
import {
  accelerometer,
  gyroscope,
  SensorTypes,
  setUpdateIntervalForType,
} from 'react-native-sensors';
import type { Subscription } from 'rxjs';

type SensorReading = {
  x: number;
  y: number;
  z: number;
  timestamp: number;
};

type SensorEnvelope = {
  timestamp: number;
  accelerometer: SensorReading;
  gyroscope: SensorReading;
};

type ServerToClientEvents = {
  connected: (payload: { message: string }) => void;
  sensor_update: (payload: SensorEnvelope) => void;
  sensor_snapshot: (payload: SensorEnvelope) => void;
  error: (payload: { message: string }) => void;
  fall_detected: (payload: {
    message: string;
    timestamp?: string;
    acceleration?: number;
  }) => void;
};

type ClientToServerEvents = {
  sensor_update: (payload: SensorEnvelope) => void;
};

type TelemetrySocket = Socket<ServerToClientEvents, ClientToServerEvents>;

type SocketStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

const SOCKET_STATUS_LABEL: Record<SocketStatus, string> = {
  disconnected: 'Disconnected',
  connecting: 'Connecting…',
  connected: 'Connected',
  error: 'Connection error',
};

const SENSOR_INTERVAL_MS = 100;
const INITIAL_READING: SensorReading = {
  x: 0,
  y: 0,
  z: 0,
  timestamp: 0,
};

function App() {
  const isDarkMode = useColorScheme() === 'dark';

  return (
    <SafeAreaProvider>
      <StatusBar barStyle={isDarkMode ? 'light-content' : 'dark-content'} />
      <SafeAreaView
        style={[styles.safeArea, isDarkMode ? styles.darkBackground : styles.lightBackground]}
      >
        <AppContent isDarkMode={isDarkMode} />
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

type AppContentProps = {
  isDarkMode: boolean;
};

function AppContent({ isDarkMode }: AppContentProps) {
  const insets = useSafeAreaInsets();
  const [tracking, setTracking] = useState(true);
  const [accelerometerReading, setAccelerometerReading] =
    useState<SensorReading>(INITIAL_READING);
  const [gyroscopeReading, setGyroscopeReading] =
    useState<SensorReading>(INITIAL_READING);
  const [serverUrl, setServerUrl] = useState('http://localhost:3000/api/sensors');
  const [isSending, setIsSending] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [socketUrl, setSocketUrl] = useState('http://localhost:3000/stream');
  const [socketStatus, setSocketStatus] = useState<SocketStatus>('disconnected');
  const [socketStatusMessage, setSocketStatusMessage] = useState<string | null>(null);
  const socketRef = useRef<TelemetrySocket | null>(null);

  useEffect(() => {
    setUpdateIntervalForType(SensorTypes.accelerometer, SENSOR_INTERVAL_MS);
    setUpdateIntervalForType(SensorTypes.gyroscope, SENSOR_INTERVAL_MS);
  }, []);

  useEffect(() => {
    if (!tracking) {
      return;
    }

    const subscriptions: Subscription[] = [];

    subscriptions.push(
      accelerometer.subscribe(
        reading => setAccelerometerReading(reading),
        error => console.warn('Accelerometer error', error),
      ),
    );

    subscriptions.push(
      gyroscope.subscribe(
        reading => setGyroscopeReading(reading),
        error => console.warn('Gyroscope error', error),
      ),
    );

    return () => {
      subscriptions.forEach(subscription => subscription.unsubscribe());
    };
  }, [tracking]);

  const disconnectSocket = useCallback(() => {
    const socket = socketRef.current;
    if (socket) {
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
    }
    setSocketStatus('disconnected');
  }, []);

  useEffect(() => {
    if (!tracking) {
      disconnectSocket();
      return;
    }

    const trimmedUrl = socketUrl.trim();
    if (!trimmedUrl) {
      disconnectSocket();
      setSocketStatusMessage('Enter a WebSocket URL to stream data.');
      return;
    }

    setSocketStatus('connecting');
    setSocketStatusMessage('Connecting to WebSocket…');

    try {
      const socket: TelemetrySocket = io(trimmedUrl, {
        transports: ['websocket'],
      });

      socketRef.current = socket;

      socket.on('connect', () => {
        setSocketStatus('connected');
        setSocketStatusMessage('WebSocket connected. Streaming live data.');
      });

      socket.on('fall_detected', (payload: { message?: string }) => {
        console.warn('FALL DETECTED by server', payload);
        Alert.alert(
          'Fall Detected!',
          payload?.message || 'The server detected a potential fall.',
          [{ text: 'OK' }],
        );
      });

      socket.on('connect_error', (error: Error) => {
        console.warn('Socket connect error', error);
        setSocketStatus('error');
        setSocketStatusMessage(error.message || 'Connection error.');
      });

      socket.on('error', (payload: unknown) => {
        const message =
          typeof payload === 'object' && payload !== null && 'message' in payload
            ? String((payload as { message: unknown }).message)
            : 'Server reported an error.';
        setSocketStatus('error');
        setSocketStatusMessage(message);
      });

      socket.on('disconnect', (reason: string) => {
        setSocketStatus('disconnected');
        setSocketStatusMessage(`Disconnected: ${reason}.`);
      });

      return () => {
        socket.removeAllListeners();
        socket.disconnect();
        if (socketRef.current === socket) {
          socketRef.current = null;
        }
        setSocketStatus(previous => (previous === 'error' ? previous : 'disconnected'));
      };
    } catch (error) {
      console.warn('Socket initialization failed', error);
      setSocketStatus('error');
      const message = error instanceof Error ? error.message : 'Failed to initialize WebSocket.';
      setSocketStatusMessage(message);
    }
  }, [disconnectSocket, socketUrl, tracking]);

  useEffect(() => () => disconnectSocket(), [disconnectSocket]);

  useEffect(() => {
    if (!tracking) {
      return;
    }

    const socket = socketRef.current;
    if (!socket || socket.disconnected) {
      return;
    }

    const payload: SensorEnvelope = {
      timestamp: Date.now(),
      accelerometer: accelerometerReading,
      gyroscope: gyroscopeReading,
    };

    try {
      socket.emit('sensor_update', payload);
    } catch (error) {
      console.warn('Socket emit failed', error);
      setSocketStatus('error');
      const message = error instanceof Error ? error.message : 'Failed to send to WebSocket.';
      setSocketStatusMessage(message);
    }
  }, [accelerometerReading, gyroscopeReading, tracking]);

  const stopTracking = useCallback(() => {
    setTracking(false);
    disconnectSocket();
    setAccelerometerReading({ ...INITIAL_READING, timestamp: Date.now() });
    setGyroscopeReading({ ...INITIAL_READING, timestamp: Date.now() });
    setSocketStatusMessage('Streaming paused; connection closed.');
  }, [disconnectSocket]);

  const startTracking = useCallback(() => {
    setSocketStatusMessage(null);
    setTracking(true);
  }, []);

  const formattedAccelerometer = useMemo(
    () => formatReading(accelerometerReading),
    [accelerometerReading],
  );
  const formattedGyroscope = useMemo(
    () => formatReading(gyroscopeReading),
    [gyroscopeReading],
  );

  const sendSnapshot = useCallback(async () => {
    const url = serverUrl.trim();

    if (!url) {
      setStatusMessage('Enter a server URL to send data.');
      return;
    }

    const payload = {
      timestamp: Date.now(),
      accelerometer: accelerometerReading,
      gyroscope: gyroscopeReading,
    };

    try {
      setIsSending(true);
      setStatusMessage(null);

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        setStatusMessage(`Server responded with status ${response.status}`);
        return;
      }

      setStatusMessage('Sensor snapshot sent successfully.');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      setStatusMessage(`Failed to send snapshot: ${message}`);
    } finally {
      setIsSending(false);
    }
  }, [accelerometerReading, gyroscopeReading, serverUrl]);

  const textColor = isDarkMode ? styles.textLight : styles.textDark;

  return (
    <View
      style={[styles.container, { paddingTop: insets.top || 16 }]}
    >
      <Text style={[styles.title, textColor]}>Motion Monitor</Text>
      <Text style={[styles.subtitle, textColor]}>
        Real-time accelerometer and gyroscope readings from the device sensors.
      </Text>

      <View
        style={[
          styles.section,
          isDarkMode ? styles.sectionDark : styles.sectionLight,
        ]}
      >
        <Text style={[styles.sectionTitle, textColor]}>Sensor Tracking</Text>
        <View style={styles.buttonRow}>
          <Button
            onPress={startTracking}
            title="Start"
            disabled={tracking}
          />
          <Button
            onPress={stopTracking}
            title="Stop"
            disabled={!tracking}
            color="#d9534f"
          />
        </View>
      </View>

      <View
        style={[
          styles.section,
          isDarkMode ? styles.sectionDark : styles.sectionLight,
        ]}
      >
        <Text style={[styles.sectionTitle, textColor]}>Live Stream</Text>
        <Text style={[styles.helperText, textColor]}>
          When tracking is active, Motion Monitor connects to a Socket.IO endpoint and emits live sensor_update events.
        </Text>
        <TextInput
          value={socketUrl}
          onChangeText={setSocketUrl}
          placeholder="http://localhost:3000/stream"
          style={[styles.input, isDarkMode ? styles.inputDark : styles.inputLight]}
          placeholderTextColor={isDarkMode ? '#888' : '#666'}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />
        <View style={styles.statusRow}>
          <View
            style={[
              styles.connectionDot,
              socketStatus === 'connected'
                ? styles.connectionDotConnected
                : socketStatus === 'connecting'
                ? styles.connectionDotConnecting
                : socketStatus === 'error'
                ? styles.connectionDotError
                : styles.connectionDotDisconnected,
            ]}
          />
          <Text style={[styles.statusText, textColor]}>
            {SOCKET_STATUS_LABEL[socketStatus]}
          </Text>
        </View>
        {socketStatusMessage ? (
          <Text style={[styles.statusTextSmall, textColor]}>{socketStatusMessage}</Text>
        ) : null}
      </View>

      <View
        style={[
          styles.section,
          isDarkMode ? styles.sectionDark : styles.sectionLight,
        ]}
      >
        <Text style={[styles.sectionTitle, textColor]}>Accelerometer (m/s²)</Text>
        <SensorReadingRow
          labels={['X', 'Y', 'Z']}
          values={formattedAccelerometer}
          isDarkMode={isDarkMode}
        />
        <Text style={[styles.timestampText, textColor]}>
          Updated {formatTimestamp(accelerometerReading.timestamp)}
        </Text>
      </View>

      <View
        style={[
          styles.section,
          isDarkMode ? styles.sectionDark : styles.sectionLight,
        ]}
      >
        <Text style={[styles.sectionTitle, textColor]}>Gyroscope (rad/s)</Text>
        <SensorReadingRow
          labels={['X', 'Y', 'Z']}
          values={formattedGyroscope}
          isDarkMode={isDarkMode}
        />
        <Text style={[styles.timestampText, textColor]}>
          Updated {formatTimestamp(gyroscopeReading.timestamp)}
        </Text>
      </View>

      <View
        style={[
          styles.section,
          isDarkMode ? styles.sectionDark : styles.sectionLight,
        ]}
      >
        <Text style={[styles.sectionTitle, textColor]}>Send Snapshot</Text>
        <Text style={[styles.helperText, textColor]}>
          Provide an HTTP endpoint to receive JSON payloads. This button sends the
          latest accelerometer and gyroscope readings.
        </Text>
        <TextInput
          value={serverUrl}
          onChangeText={setServerUrl}
          placeholder="https://example.com/api/sensor"
          style={[styles.input, isDarkMode ? styles.inputDark : styles.inputLight]}
          placeholderTextColor={isDarkMode ? '#888' : '#666'}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />
        <View style={styles.buttonRow}>
          <Button onPress={sendSnapshot} title="Send Snapshot" disabled={isSending} />
        </View>
        <View style={styles.statusRow}>
          {isSending ? (
            <ActivityIndicator size="small" color={isDarkMode ? '#fff' : '#000'} />
          ) : null}
          {statusMessage ? (
            <Text style={[styles.statusText, textColor]}>{statusMessage}</Text>
          ) : null}
        </View>
      </View>
    </View>
  );
}

type SensorReadingRowProps = {
  labels: [string, string, string];
  values: [string, string, string];
  isDarkMode: boolean;
};

function SensorReadingRow({ labels, values, isDarkMode }: SensorReadingRowProps) {
  return (
    <View style={styles.readingRow}>
      {labels.map((label, index) => (
        <View key={label} style={styles.readingColumn}>
          <Text
            style={[
              styles.readingLabel,
              isDarkMode ? styles.readingLabelDark : styles.readingLabelLight,
            ]}
          >
            {label}
          </Text>
          <Text
            style={[
              styles.readingValue,
              isDarkMode ? styles.readingValueDark : styles.readingValueLight,
            ]}
          >
            {values[index]}
          </Text>
        </View>
      ))}
    </View>
  );
}

function formatReading(reading: SensorReading): [string, string, string] {
  return [reading.x, reading.y, reading.z].map(value => value.toFixed(3)) as [
    string,
    string,
    string,
  ];
}

function formatTimestamp(timestamp: number): string {
  if (!timestamp) {
    return '—';
  }

  return new Date(timestamp).toLocaleTimeString();
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
  },
  container: {
    flex: 1,
    paddingHorizontal: 24,
    gap: 24,
  },
  lightBackground: {
    backgroundColor: '#f5f7fa',
  },
  darkBackground: {
    backgroundColor: '#101218',
  },
  textLight: {
    color: '#f2f2f2',
  },
  textDark: {
    color: '#111',
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 16,
    lineHeight: 22,
  },
  section: {
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
  },
  sectionLight: {
    backgroundColor: '#ffffff',
    borderColor: '#e0e6ed',
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowOffset: { width: 0, height: 4 },
    shadowRadius: 8,
    elevation: 4,
  },
  sectionDark: {
    backgroundColor: '#181b24',
    borderColor: '#242a36',
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowOffset: { width: 0, height: 4 },
    shadowRadius: 8,
    elevation: 4,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 12,
  },
  helperText: {
    fontSize: 14,
    marginBottom: 12,
  },
  input: {
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    marginBottom: 12,
    borderWidth: 1,
  },
  inputLight: {
    backgroundColor: '#fff',
    borderColor: '#ccd6dd',
    color: '#111',
  },
  inputDark: {
    backgroundColor: '#1c1f27',
    borderColor: '#2e3441',
    color: '#f2f2f2',
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 16,
  },
  statusRow: {
    marginTop: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  statusText: {
    fontSize: 14,
  },
  statusTextSmall: {
    fontSize: 12,
    marginTop: 8,
  },
  readingRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 16,
  },
  readingColumn: {
    flex: 1,
    alignItems: 'center',
  },
  readingLabel: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 4,
  },
  readingLabelLight: {
    color: '#6c7a89',
  },
  readingLabelDark: {
    color: '#a2adb9',
  },
  readingValue: {
    fontSize: 20,
    fontVariant: ['tabular-nums'],
    fontWeight: '600',
  },
  readingValueLight: {
    color: '#2c3e50',
  },
  readingValueDark: {
    color: '#f0f4ff',
  },
  timestampText: {
    fontSize: 12,
    marginTop: 12,
    opacity: 0.75,
  },
  connectionDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#6c7a89',
  },
  connectionDotConnected: {
    backgroundColor: '#28a745',
  },
  connectionDotConnecting: {
    backgroundColor: '#f0ad4e',
  },
  connectionDotDisconnected: {
    backgroundColor: '#6c7a89',
  },
  connectionDotError: {
    backgroundColor: '#d9534f',
  },
});

export default App;
