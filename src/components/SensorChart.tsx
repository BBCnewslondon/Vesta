import React, { useMemo, useState } from 'react';
import { LayoutChangeEvent, StyleSheet, Text, View } from 'react-native';
import Svg, { G, Line, Path } from 'react-native-svg';

const CHART_HEIGHT = 160;
const GRID_LINE_COUNT = 4;
const HORIZONTAL_PADDING = 16;
const VERTICAL_PADDING = 12;

const chartPalette = {
  surfaceLight: '#FFE6D0',
  surfaceDark: '#2B1A14',
  borderLight: '#F2B27C',
  borderDark: '#4A2A1D',
  textLight: '#FBD9B4',
  textDark: '#3C1F13',
  gridLight: '#F4D8C1',
  gridDark: '#3C241B',
};

export type ChartSeries = {
  label: string;
  color: string;
  values: number[];
};

export type SensorChartProps = {
  timestamps: number[];
  series: ChartSeries[];
  isDarkMode: boolean;
};

type ComputedPath = {
  color: string;
  d: string;
};

type ChartComputation = {
  paths: ComputedPath[];
  minValue: number;
  maxValue: number;
};

function SensorChart({ timestamps, series, isDarkMode }: SensorChartProps) {
  const [width, setWidth] = useState(0);

  const handleLayout = (event: LayoutChangeEvent) => {
    const nextWidth = event.nativeEvent.layout.width;
    if (nextWidth !== width) {
      setWidth(nextWidth);
    }
  };

  const chartData = useMemo<ChartComputation>(() => {
    const chartWidth = Math.max(0, width - HORIZONTAL_PADDING * 2);
    const chartHeight = Math.max(0, CHART_HEIGHT - VERTICAL_PADDING * 2);
    if (!chartWidth || !chartHeight) {
      return { paths: [], minValue: 0, maxValue: 0 };
    }

    const points = timestamps.length;
    if (points < 2) {
      return { paths: [], minValue: 0, maxValue: 0 };
    }

    const meaningfulSeries = series.filter(item => item.values.length === points);
    if (meaningfulSeries.length === 0) {
      return { paths: [], minValue: 0, maxValue: 0 };
    }

    const flattened = meaningfulSeries.flatMap(item =>
      item.values.filter(value => Number.isFinite(value)),
    );
    if (flattened.length === 0) {
      return { paths: [], minValue: 0, maxValue: 0 };
    }

    const minValue = Math.min(...flattened);
    const maxValue = Math.max(...flattened);
    const range = maxValue - minValue || Math.max(1, Math.abs(maxValue) || 1);

    const startTime = timestamps[0];
    const endTime = timestamps[timestamps.length - 1];
    const timeRange = endTime - startTime || 1;

    const paths = meaningfulSeries
      .map(seriesItem => {
        // Map raw samples into normalized SVG coordinates for the current series.
        const path = seriesItem.values.reduce<string | null>((acc, value, index) => {
          const ratioX = (timestamps[index] - startTime) / timeRange;
          const x = HORIZONTAL_PADDING + ratioX * chartWidth;
          const ratioY = (value - minValue) / range;
          const y = VERTICAL_PADDING + (1 - ratioY) * chartHeight;

          if (Number.isNaN(x) || Number.isNaN(y)) {
            return acc;
          }

          if (!acc) {
            return `M ${x} ${y}`;
          }

          return `${acc} L ${x} ${y}`;
        }, null);

        if (!path) {
          return null;
        }

        return { color: seriesItem.color, d: path };
      })
      .filter((item): item is ComputedPath => Boolean(item));

    return { paths, minValue, maxValue };
  }, [series, timestamps, width]);

  const textColor = isDarkMode ? styles.textLight : styles.textDark;
  const gridColor = isDarkMode ? styles.gridDark : styles.gridLight;

  return (
    <View style={styles.wrapper}>
      <View
        style={[styles.chartSurface, isDarkMode ? styles.surfaceDark : styles.surfaceLight]}
        onLayout={handleLayout}
      >
        {chartData.paths.length === 0 ? (
          <Text style={[styles.placeholderText, textColor]}>Collecting sensor samples…</Text>
        ) : (
          <Svg height={CHART_HEIGHT} width={width}>
            <G>
              {Array.from({ length: GRID_LINE_COUNT + 1 }).map((_, index) => {
                const y =
                  VERTICAL_PADDING +
                  ((CHART_HEIGHT - VERTICAL_PADDING * 2) / GRID_LINE_COUNT) * index;
                return (
                  <Line
                    key={`grid-${index}`}
                    x1={HORIZONTAL_PADDING}
                    x2={Math.max(HORIZONTAL_PADDING, width - HORIZONTAL_PADDING)}
                    y1={y}
                    y2={y}
                    stroke={gridColor.color}
                    strokeWidth={1}
                    strokeDasharray="4,6"
                  />
                );
              })}
              {chartData.paths.map(path => (
                <Path
                  key={path.color}
                  d={path.d}
                  stroke={path.color}
                  strokeWidth={2}
                  fill="none"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              ))}
            </G>
          </Svg>
        )}
      </View>
      <View style={styles.legendRow}>
        {series.map(item => (
          <View key={item.label} style={styles.legendItem}>
            <View style={[styles.legendSwatch, { backgroundColor: item.color }]} />
            <Text style={[styles.legendText, textColor]}>{item.label}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    gap: 8,
  },
  chartSurface: {
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: 1,
    justifyContent: 'center',
  },
  surfaceLight: {
    borderColor: chartPalette.borderLight,
    backgroundColor: chartPalette.surfaceLight,
  },
  surfaceDark: {
    borderColor: chartPalette.borderDark,
    backgroundColor: chartPalette.surfaceDark,
  },
  placeholderText: {
    textAlign: 'center',
    fontSize: 14,
  },
  legendRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  legendSwatch: {
    width: 12,
    height: 12,
    borderRadius: 6,
  },
  legendText: {
    fontSize: 12,
  },
  textLight: {
    color: chartPalette.textLight,
  },
  textDark: {
    color: chartPalette.textDark,
  },
  gridLight: {
    color: chartPalette.gridLight,
  },
  gridDark: {
    color: chartPalette.gridDark,
  },
});

export default SensorChart;
