import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Button,
  ScrollView,
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
import SensorChart, { ChartSeries } from './src/components/SensorChart';

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

const palette = {
  backgroundLight: '#FFF4E6',
  backgroundDark: '#1D130D',
  surfaceLight: '#FFE1C6',
  surfaceDark: '#2C1A14',
  borderLight: '#F2B27C',
  borderDark: '#4A2A1D',
  textOnLight: '#432616',
  textOnDark: '#FCE3C6',
  headingLight: '#B74822',
  headingDark: '#F7B17C',
  accent: '#D06A3B',
  accentAlt: '#F19953',
  accentSoft: '#F5C396',
  success: '#9BCF8F',
  warning: '#F2AE66',
  danger: '#E3653C',
  idle: '#B18C7B',
};

const SENSOR_INTERVAL_MS = 500;
const INITIAL_READING: SensorReading = {
  x: 0,
  y: 0,
  z: 0,
  timestamp: 0,
};
const HISTORY_LIMIT = 200;
const CLINICIAN_HISTORY_LIMIT = 50;

type SensorSample = SensorReading & {
  magnitude: number;
};

type ClinicianSample = {
  timestamp: number;
  magnitude: number;
};

function coerceNumber(value: number | string | null | undefined): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function computeMagnitude(reading: SensorReading): number {
  const x = coerceNumber(reading.x);
  const y = coerceNumber(reading.y);
  const z = coerceNumber(reading.z);
  return Math.sqrt(x ** 2 + y ** 2 + z ** 2);
}

function appendSample(history: SensorSample[], reading: SensorReading): SensorSample[] {
  if (!reading.timestamp) {
    return history;
  }

  const sample: SensorSample = {
    ...reading,
    magnitude: computeMagnitude(reading),
  };

  const next = [...history, sample];
  if (next.length > HISTORY_LIMIT) {
    return next.slice(next.length - HISTORY_LIMIT);
  }

  return next;
}

function appendClinicianSample(
  history: ClinicianSample[],
  payload: SensorEnvelope,
): ClinicianSample[] {
  const baseTimestamp = payload.timestamp || payload.accelerometer?.timestamp;
  const reading = payload.accelerometer;

  const timestampValue = Number(baseTimestamp);

  if (!reading || !Number.isFinite(timestampValue)) {
    return history;
  }

  const magnitude = computeMagnitude(reading);
  const sample: ClinicianSample = {
    timestamp: timestampValue,
    magnitude,
  };

  const next = [...history, sample];
  if (next.length > CLINICIAN_HISTORY_LIMIT) {
    return next.slice(next.length - CLINICIAN_HISTORY_LIMIT);
  }

  return next;
}

function computeMagnitudeStats(history: SensorSample[]):
  | { min: number; max: number; mean: number }
  | null {
  if (history.length === 0) {
    return null;
  }

  const magnitudes = history.map(sample => sample.magnitude);
  const min = Math.min(...magnitudes);
  const max = Math.max(...magnitudes);
  const mean = magnitudes.reduce((sum, value) => sum + value, 0) / magnitudes.length;

  return { min, max, mean };
}

function computeWindowSeconds(history: SensorSample[]): number | null {
  if (history.length < 2) {
    return null;
  }

  const first = history[0]?.timestamp ?? 0;
  const last = history[history.length - 1]?.timestamp ?? 0;
  if (!first || !last || last <= first) {
    return null;
  }

  return (last - first) / 1000;
}

function App() {
  const isDarkMode = useColorScheme() === 'dark';

  return (
    <SafeAreaProvider>
      <StatusBar
        barStyle={isDarkMode ? 'light-content' : 'dark-content'}
        backgroundColor={isDarkMode ? palette.backgroundDark : palette.backgroundLight}
      />
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
  const [accelerometerHistory, setAccelerometerHistory] = useState<SensorSample[]>([]);
  const [gyroscopeHistory, setGyroscopeHistory] = useState<SensorSample[]>([]);
  const [clinicianHistory, setClinicianHistory] = useState<ClinicianSample[]>([]);
  const [serverUrl, setServerUrl] = useState('http://localhost:3000/api/sensors');
  const [isSending, setIsSending] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [socketUrl, setSocketUrl] = useState('http://localhost:3000/stream');
  const [socketStatus, setSocketStatus] = useState<SocketStatus>('disconnected');
  const [socketStatusMessage, setSocketStatusMessage] = useState<string | null>(null);
  const [cadence, setCadence] = useState(0);
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
        reading =>
          setAccelerometerReading({
            ...reading,
            timestamp: Date.now(),
          }),
        error => console.warn('Accelerometer error', error),
      ),
    );

    subscriptions.push(
      gyroscope.subscribe(
        reading =>
          setGyroscopeReading({
            ...reading,
            timestamp: Date.now(),
          }),
        error => console.warn('Gyroscope error', error),
      ),
    );

    return () => {
      subscriptions.forEach(subscription => subscription.unsubscribe());
    };
  }, [tracking]);

  useEffect(() => {
    if (!tracking) {
      return;
    }

    setAccelerometerHistory(previous => appendSample(previous, accelerometerReading));
  }, [accelerometerReading, tracking]);

  useEffect(() => {
    if (!tracking) {
      return;
    }

    setGyroscopeHistory(previous => appendSample(previous, gyroscopeReading));
  }, [gyroscopeReading, tracking]);

  const disconnectSocket = useCallback(() => {
    const socket = socketRef.current;
    if (socket) {
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
    }
    setSocketStatus('disconnected');
    setClinicianHistory([]);
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

      socket.on('sensor_update', (payload: SensorEnvelope) => {
        setClinicianHistory(previous => appendClinicianSample(previous, payload));
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
    setAccelerometerHistory([]);
    setGyroscopeHistory([]);
    setClinicianHistory([]);
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

  const accelerometerTimestamps = useMemo(
    () => accelerometerHistory.map(sample => sample.timestamp),
    [accelerometerHistory],
  );
  const gyroscopeTimestamps = useMemo(
    () => gyroscopeHistory.map(sample => sample.timestamp),
    [gyroscopeHistory],
  );

  const accelerometerSeries = useMemo<ChartSeries[]>(
    () => [
      {
        label: 'Acc X',
        color: '#ff6b6b',
        values: accelerometerHistory.map(sample => sample.x),
      },
      {
        label: 'Acc Y',
        color: '#feca57',
        values: accelerometerHistory.map(sample => sample.y),
      },
      {
        label: 'Acc Z',
        color: '#1dd1a1',
        values: accelerometerHistory.map(sample => sample.z),
      },
      {
        label: '|a|',
        color: '#54a0ff',
        values: accelerometerHistory.map(sample => sample.magnitude),
      },
    ],
    [accelerometerHistory],
  );

  const gyroscopeSeries = useMemo<ChartSeries[]>(
    () => [
      {
        label: 'Gyro X',
        color: '#ff9ff3',
        values: gyroscopeHistory.map(sample => sample.x),
      },
      {
        label: 'Gyro Y',
        color: '#48dbfb',
        values: gyroscopeHistory.map(sample => sample.y),
      },
      {
        label: 'Gyro Z',
        color: '#1dd1a1',
        values: gyroscopeHistory.map(sample => sample.z),
      },
      {
        label: '|omega|',
        color: '#5f27cd',
        values: gyroscopeHistory.map(sample => sample.magnitude),
      },
    ],
    [gyroscopeHistory],
  );

  const clinicianTimestamps = useMemo(
    () => clinicianHistory.map(sample => sample.timestamp),
    [clinicianHistory],
  );

  const clinicianSeries = useMemo<ChartSeries[]>(
    () => [
      {
        label: 'Stream |a|',
        color: '#8854d0',
        values: clinicianHistory.map(sample => sample.magnitude),
      },
    ],
    [clinicianHistory],
  );

  const accelerometerStats = useMemo(
    () => computeMagnitudeStats(accelerometerHistory),
    [accelerometerHistory],
  );
  const gyroscopeStats = useMemo(
    () => computeMagnitudeStats(gyroscopeHistory),
    [gyroscopeHistory],
  );

  const accelerometerWindowSeconds = useMemo(
    () => computeWindowSeconds(accelerometerHistory),
    [accelerometerHistory],
  );
  const gyroscopeWindowSeconds = useMemo(
    () => computeWindowSeconds(gyroscopeHistory),
    [gyroscopeHistory],
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

  const fetchGaitAnalysis = useCallback(async () => {
    try {
      const response = await fetch('http://localhost:3000/api/gait-analysis');
      if (!response.ok) {
        throw new Error(`Server responded with status ${response.status}`);
      }

      const payload = await response.json();
      const cadenceValue = Number(payload?.cadence);

      if (!Number.isFinite(cadenceValue)) {
        throw new Error('Cadence value missing from gait analysis response.');
      }

      setCadence(cadenceValue);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error occurred.';
      Alert.alert('Gait analysis failed', message);
    }
  }, [setCadence]);

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={[styles.container, { paddingTop: insets.top || 16 }]}
    >
      <View
        style={[styles.heroCard, isDarkMode ? styles.heroCardDark : styles.heroCardLight]}
      >
        <Text
          style={[styles.title, isDarkMode ? styles.titleDark : styles.titleLight]}
        >
          Motion Monitor
        </Text>
        <Text
          style={[styles.subtitle, isDarkMode ? styles.heroSubtitleDark : styles.heroSubtitleLight]}
        >
          Real-time accelerometer and gyroscope readings from the device sensors.
        </Text>
      </View>

      <View
        style={[
          styles.section,
          isDarkMode ? styles.sectionDark : styles.sectionLight,
        ]}
      >
        <Text
          style={[styles.sectionTitle, isDarkMode ? styles.sectionTitleDark : styles.sectionTitleLight]}
        >
          Sensor Tracking
        </Text>
        <View style={styles.buttonRow}>
          <Button
            onPress={startTracking}
            title="Start"
            disabled={tracking}
            color={palette.accent}
          />
          <Button
            onPress={stopTracking}
            title="Stop"
            disabled={!tracking}
            color={palette.danger}
          />
        </View>
      </View>

      <View
        style={[
          styles.section,
          isDarkMode ? styles.sectionDark : styles.sectionLight,
        ]}
      >
        <Text
          style={[styles.sectionTitle, isDarkMode ? styles.sectionTitleDark : styles.sectionTitleLight]}
        >
          Live Stream
        </Text>
        <Text style={[styles.helperText, textColor]}>
          When tracking is active, Motion Monitor connects to a Socket.IO endpoint and emits live sensor_update events.
        </Text>
        <TextInput
          value={socketUrl}
          onChangeText={setSocketUrl}
          placeholder="http://localhost:3000/stream"
          style={[styles.input, isDarkMode ? styles.inputDark : styles.inputLight]}
          placeholderTextColor={isDarkMode ? '#9E8372' : '#B58D74'}
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
        <Text
          style={[styles.sectionTitle, isDarkMode ? styles.sectionTitleDark : styles.sectionTitleLight]}
        >
          Clinician Dashboard
        </Text>
        <Text style={[styles.helperText, textColor]}>
          Last {CLINICIAN_HISTORY_LIMIT} streamed accelerometer magnitudes from the backend feed.
        </Text>
        <SensorChart
          timestamps={clinicianTimestamps}
          series={clinicianSeries}
          isDarkMode={isDarkMode}
        />
      </View>

      <View
        style={[
          styles.section,
          isDarkMode ? styles.sectionDark : styles.sectionLight,
        ]}
      >
        <Text
          style={[styles.sectionTitle, isDarkMode ? styles.sectionTitleDark : styles.sectionTitleLight]}
        >
          Physiotherapy Tools
        </Text>
        <Text style={[styles.helperText, textColor]}>
          Run a gait analysis to estimate cadence from recent sensor history.
        </Text>
        <View style={styles.buttonRow}>
          <Button title="Analyze Gait" onPress={fetchGaitAnalysis} color={palette.accentAlt} />
        </View>
        <Text style={[styles.statusText, textColor]}>
          Cadence: {cadence.toFixed(1)} steps/min
        </Text>
      </View>

      <View
        style={[
          styles.section,
          isDarkMode ? styles.sectionDark : styles.sectionLight,
        ]}
      >
        <Text
          style={[styles.sectionTitle, isDarkMode ? styles.sectionTitleDark : styles.sectionTitleLight]}
        >
          Accelerometer (m/s^2)
        </Text>
        <SensorReadingRow
          labels={['X', 'Y', 'Z']}
          values={formattedAccelerometer}
          isDarkMode={isDarkMode}
        />
        <Text style={[styles.timestampText, textColor]}>
          Updated {formatTimestamp(accelerometerReading.timestamp)}
        </Text>
        <View style={styles.chartBlock}>
          <Text style={[styles.helperTextSmall, textColor]}>
            {accelerometerWindowSeconds
              ? `Showing last ${accelerometerWindowSeconds.toFixed(1)} s of samples.`
              : 'Collecting samples for trend view.'}
          </Text>
          <SensorChart
            timestamps={accelerometerTimestamps}
            series={accelerometerSeries}
            isDarkMode={isDarkMode}
          />
          {accelerometerStats ? (
            <View style={styles.statsRow}>
              <StatBlock
                label="Min |a|"
                value={`${accelerometerStats.min.toFixed(2)} m/s^2`}
                isDarkMode={isDarkMode}
              />
              <StatBlock
                label="Mean |a|"
                value={`${accelerometerStats.mean.toFixed(2)} m/s^2`}
                isDarkMode={isDarkMode}
              />
              <StatBlock
                label="Max |a|"
                value={`${accelerometerStats.max.toFixed(2)} m/s^2`}
                isDarkMode={isDarkMode}
              />
            </View>
          ) : null}
        </View>
      </View>

      <View
        style={[
          styles.section,
          isDarkMode ? styles.sectionDark : styles.sectionLight,
        ]}
      >
        <Text
          style={[styles.sectionTitle, isDarkMode ? styles.sectionTitleDark : styles.sectionTitleLight]}
        >
          Gyroscope (rad/s)
        </Text>
        <SensorReadingRow
          labels={['X', 'Y', 'Z']}
          values={formattedGyroscope}
          isDarkMode={isDarkMode}
        />
        <Text style={[styles.timestampText, textColor]}>
          Updated {formatTimestamp(gyroscopeReading.timestamp)}
        </Text>
        <View style={styles.chartBlock}>
          <Text style={[styles.helperTextSmall, textColor]}>
            {gyroscopeWindowSeconds
              ? `Showing last ${gyroscopeWindowSeconds.toFixed(1)} s of samples.`
              : 'Collecting samples for trend view.'}
          </Text>
          <SensorChart
            timestamps={gyroscopeTimestamps}
            series={gyroscopeSeries}
            isDarkMode={isDarkMode}
          />
          {gyroscopeStats ? (
            <View style={styles.statsRow}>
              <StatBlock
                label="Min |omega|"
                value={`${gyroscopeStats.min.toFixed(2)} rad/s`}
                isDarkMode={isDarkMode}
              />
              <StatBlock
                label="Mean |omega|"
                value={`${gyroscopeStats.mean.toFixed(2)} rad/s`}
                isDarkMode={isDarkMode}
              />
              <StatBlock
                label="Max |omega|"
                value={`${gyroscopeStats.max.toFixed(2)} rad/s`}
                isDarkMode={isDarkMode}
              />
            </View>
          ) : null}
        </View>
      </View>

      <View
        style={[
          styles.section,
          isDarkMode ? styles.sectionDark : styles.sectionLight,
        ]}
      >
        <Text
          style={[styles.sectionTitle, isDarkMode ? styles.sectionTitleDark : styles.sectionTitleLight]}
        >
          Send Snapshot
        </Text>
        <Text style={[styles.helperText, textColor]}>
          Provide an HTTP endpoint to receive JSON payloads. This button sends the
          latest accelerometer and gyroscope readings.
        </Text>
        <TextInput
          value={serverUrl}
          onChangeText={setServerUrl}
          placeholder="https://example.com/api/sensor"
          style={[styles.input, isDarkMode ? styles.inputDark : styles.inputLight]}
          placeholderTextColor={isDarkMode ? '#9E8372' : '#B58D74'}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />
        <View style={styles.buttonRow}>
          <Button
            onPress={sendSnapshot}
            title="Send Snapshot"
            disabled={isSending}
            color={palette.accent}
          />
        </View>
        <View style={styles.statusRow}>
          {isSending ? (
            <ActivityIndicator
              size="small"
              color={isDarkMode ? palette.textOnDark : palette.textOnLight}
            />
          ) : null}
          {statusMessage ? (
            <Text style={[styles.statusText, textColor]}>{statusMessage}</Text>
          ) : null}
        </View>
      </View>
    </ScrollView>
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

type StatBlockProps = {
  label: string;
  value: string;
  isDarkMode: boolean;
};

function StatBlock({ label, value, isDarkMode }: StatBlockProps) {
  return (
    <View
      style={[
        styles.statBlock,
        isDarkMode ? styles.statBlockDark : styles.statBlockLight,
      ]}
    >
      <Text
        style={[
          styles.statLabel,
          isDarkMode ? styles.readingLabelDark : styles.readingLabelLight,
        ]}
      >
        {label}
      </Text>
      <Text
        style={[
          styles.statValue,
          isDarkMode ? styles.readingValueDark : styles.readingValueLight,
        ]}
      >
        {value}
      </Text>
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
  scroll: {
    flex: 1,
  },
  container: {
    paddingHorizontal: 24,
    paddingBottom: 40,
    gap: 24,
  },
  lightBackground: {
    backgroundColor: palette.backgroundLight,
  },
  darkBackground: {
    backgroundColor: palette.backgroundDark,
  },
  textLight: {
    color: palette.textOnDark,
  },
  textDark: {
    color: palette.textOnLight,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    marginBottom: 8,
    letterSpacing: 0.5,
  },
  titleLight: {
    color: palette.headingLight,
  },
  titleDark: {
    color: palette.headingDark,
  },
  heroCard: {
    borderRadius: 16,
    paddingHorizontal: 20,
    paddingVertical: 18,
    borderWidth: 1,
    marginBottom: 8,
  },
  heroCardLight: {
    backgroundColor: palette.accentSoft,
    borderColor: palette.borderLight,
    shadowColor: '#572815',
    shadowOpacity: 0.1,
    shadowOffset: { width: 0, height: 8 },
    shadowRadius: 16,
    elevation: 6,
  },
  heroCardDark: {
    backgroundColor: '#3B221A',
    borderColor: palette.borderDark,
    shadowColor: '#000',
    shadowOpacity: 0.45,
    shadowOffset: { width: 0, height: 6 },
    shadowRadius: 18,
    elevation: 6,
  },
  subtitle: {
    fontSize: 16,
    lineHeight: 22,
    marginTop: 4,
  },
  heroSubtitleLight: {
    color: palette.textOnLight,
    opacity: 0.85,
  },
  heroSubtitleDark: {
    color: palette.textOnDark,
    opacity: 0.85,
  },
  section: {
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
  },
  sectionLight: {
    backgroundColor: palette.surfaceLight,
    borderColor: palette.borderLight,
    shadowColor: '#552910',
    shadowOpacity: 0.08,
    shadowOffset: { width: 0, height: 4 },
    shadowRadius: 12,
    elevation: 4,
  },
  sectionDark: {
    backgroundColor: palette.surfaceDark,
    borderColor: palette.borderDark,
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowOffset: { width: 0, height: 4 },
    shadowRadius: 12,
    elevation: 4,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 12,
    letterSpacing: 0.25,
  },
  sectionTitleLight: {
    color: palette.headingLight,
  },
  sectionTitleDark: {
    color: palette.headingDark,
  },
  helperText: {
    fontSize: 14,
    marginBottom: 12,
  },
  helperTextSmall: {
    fontSize: 12,
    marginBottom: 8,
    opacity: 0.75,
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
    backgroundColor: '#FFF6EB',
    borderColor: palette.borderLight,
    color: palette.textOnLight,
  },
  inputDark: {
    backgroundColor: '#352019',
    borderColor: palette.borderDark,
    color: palette.textOnDark,
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
    color: '#7C4B33',
  },
  readingLabelDark: {
    color: '#F3C49C',
  },
  readingValue: {
    fontSize: 20,
    fontVariant: ['tabular-nums'],
    fontWeight: '600',
  },
  readingValueLight: {
    color: '#45241A',
  },
  readingValueDark: {
    color: '#FFDCC0',
  },
  timestampText: {
    fontSize: 12,
    marginTop: 12,
    opacity: 0.75,
  },
  chartBlock: {
    marginTop: 16,
    gap: 12,
  },
  statsRow: {
    marginTop: 8,
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
    flexWrap: 'wrap',
  },
  statBlock: {
    flex: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    gap: 4,
    minWidth: 96,
  },
  statBlockLight: {
    backgroundColor: '#FFEEDB',
    borderColor: palette.borderLight,
  },
  statBlockDark: {
    backgroundColor: '#3A2219',
    borderColor: palette.borderDark,
  },
  statLabel: {
    fontSize: 12,
    marginBottom: 4,
  },
  statValue: {
    fontSize: 16,
    fontVariant: ['tabular-nums'],
    fontWeight: '600',
  },
  connectionDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: palette.idle,
  },
  connectionDotConnected: {
    backgroundColor: palette.success,
  },
  connectionDotConnecting: {
    backgroundColor: palette.warning,
  },
  connectionDotDisconnected: {
    backgroundColor: palette.idle,
  },
  connectionDotError: {
    backgroundColor: palette.danger,
  },
});

export default App;
