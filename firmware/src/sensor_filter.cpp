#include "sensor_filter.h"

#include <Preferences.h>

void SensorFilter::begin() {
  Preferences calPrefs;
  if (calPrefs.begin(NVS_NAMESPACE_CAL, false)) {
    const float saved = calPrefs.getFloat("scale", HX711_COUNTS_PER_GRAM);
    calPrefs.end();
    if (isfinite(saved) && saved > 0.0f) {
      _countsPerGram = saved;
    }
  }

  _scale.begin(PIN_HX711_DOUT, PIN_HX711_SCK);
  _scale.set_scale(_countsPerGram);
  // Tare khi khay trống. Với loadcell thật: đặt khay rỗng rồi mới tare.
  delay(200);
  if (_scale.is_ready()) {
    _scale.tare(10);
    _ready = true;
    Serial.printf("[CAL] scale=%.4f counts/g\n", (double)_countsPerGram);
  } else {
    Serial.println("[SENSOR] HX711 khong san sang - dung gia tri 0");
  }
}

void SensorFilter::_saveScale(float scale) {
  _countsPerGram = scale;
  _scale.set_scale(_countsPerGram);
  Preferences calPrefs;
  if (calPrefs.begin(NVS_NAMESPACE_CAL, false)) {
    calPrefs.putFloat("scale", _countsPerGram);
    calPrefs.end();
  }
}

void SensorFilter::tare() {
  _medianIndex = 0;
  _medianCount = 0;
  _ema = 0;
  _emaInitialized = false;
  _stableIndex = 0;
  _stableCount = 0;
  _stable = false;
  if (_scale.wait_ready_timeout(300)) {
    _scale.tare(10);
    _ready = true;
    _faultCount = 0;
  }
}

bool SensorFilter::calibrate(float knownGrams) {
  if (knownGrams <= 0.0f || !_scale.wait_ready_timeout(500)) {
    return false;
  }
  const double raw = _scale.get_value(10);
  if (!isfinite(raw) || raw <= 1.0) {
    return false;
  }
  const float newScale = (float)(raw / knownGrams);
  if (!isfinite(newScale) || newScale <= 0.0f) {
    return false;
  }
  _saveScale(newScale);
  _medianIndex = 0;
  _medianCount = 0;
  _emaInitialized = false;
  _stableCount = 0;
  _stable = false;
  _ready = true;
  _faultCount = 0;
  return true;
}

void SensorFilter::resetCalibration() {
  _saveScale(HX711_COUNTS_PER_GRAM);
  _medianIndex = 0;
  _medianCount = 0;
  _emaInitialized = false;
  _stableCount = 0;
  _stable = false;
}

float SensorFilter::medianOf(float* values, uint8_t n) {
  // N = 5: insertion sort tại chỗ trên bản sao, lấy phần tử giữa.
  for (uint8_t i = 1; i < n; i++) {
    float key = values[i];
    int8_t j = (int8_t)i - 1;
    while (j >= 0 && values[j] > key) {
      values[j + 1] = values[j];
      j--;
    }
    values[j + 1] = key;
  }
  return values[n / 2];
}

float SensorFilter::update() {
  if (!_scale.is_ready()) {
    if (_faultCount < 15) {
      _faultCount++;
    }
    return _ema;
  }
  _faultCount = 0;
  if (!_ready) {
    _scale.tare(5);
    _ready = true;
  }

  float raw = _scale.get_units(1);
  if (!isfinite(raw)) {
    return _ema;
  }

  // Tầng 1: median lọc xung nhiễu khi thú cưng chạm khay.
  _median[_medianIndex] = raw;
  _medianIndex = (uint8_t)((_medianIndex + 1) % FILTER_MEDIAN_WINDOW);
  if (_medianCount < FILTER_MEDIAN_WINDOW) {
    _medianCount++;
  }

  float sorted[FILTER_MEDIAN_WINDOW];
  memcpy(sorted, _median, sizeof(sorted));
  float median = medianOf(sorted, _medianCount);

  // Tầng 2: EMA chống rung cơ học.
  if (!_emaInitialized) {
    _ema = median;
    _emaInitialized = true;
  } else {
    _ema = FILTER_EMA_ALPHA * median + (1.0f - FILTER_EMA_ALPHA) * _ema;
  }

  // Xác nhận khối lượng ổn định: max-min của M mẫu < ngưỡng.
  _stableWindow[_stableIndex] = _ema;
  _stableIndex = (uint8_t)((_stableIndex + 1) % FILTER_STABLE_SAMPLES);
  if (_stableCount < FILTER_STABLE_SAMPLES) {
    _stableCount++;
  }

  float lo = _stableWindow[0];
  float hi = _stableWindow[0];
  for (uint8_t i = 1; i < _stableCount; i++) {
    if (_stableWindow[i] < lo) lo = _stableWindow[i];
    if (_stableWindow[i] > hi) hi = _stableWindow[i];
  }
  _stable = (_stableCount >= FILTER_STABLE_SAMPLES) &&
            ((hi - lo) < FILTER_STABLE_THRESHOLD_G);

  return _ema;
}
