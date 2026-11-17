#pragma once

#include <Arduino.h>
#include <HX711.h>

#include "config.h"

// ============================================================
// [SV1] Lọc số Loadcell: Median(N=5) -> EMA(alpha=0.25) + cờ ổn định
// ============================================================
class SensorFilter {
 public:
  void begin();
  float update();  // đọc HX711, trả về khối lượng đã lọc (gam)
  void tare();
  bool calibrate(float knownGrams);
  void resetCalibration();
  float scale() const { return _countsPerGram; }
  float value() const { return _ema; }
  bool isStable() const { return _stable; }
  bool isReady() const { return _ready; }
  bool isFaulty() const { return _faultCount >= 15; }

 private:
  HX711 _scale;
  float _countsPerGram = HX711_COUNTS_PER_GRAM;
  float _median[FILTER_MEDIAN_WINDOW] = {0};
  uint8_t _medianIndex = 0;
  uint8_t _medianCount = 0;
  float _ema = 0;
  bool _emaInitialized = false;
  float _stableWindow[FILTER_STABLE_SAMPLES] = {0};
  uint8_t _stableIndex = 0;
  uint8_t _stableCount = 0;
  bool _stable = false;
  bool _ready = false;
  uint8_t _faultCount = 0;

  static float medianOf(float* values, uint8_t n);
  void _saveScale(float scale);
};
