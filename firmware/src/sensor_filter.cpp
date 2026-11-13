#include "sensor_filter.h"

void SensorFilter::begin() {
  _scale.begin(PIN_HX711_DOUT, PIN_HX711_SCK);
  _scale.set_scale(HX711_COUNTS_PER_GRAM);
  // Tare khi khay trống. Với loadcell thật: đặt khay rỗng rồi mới tare.
  delay(200);
  if (_scale.is_ready()) {
    _scale.tare(10);
    _ready = true;
  } else {
    Serial.println("[SENSOR] HX711 khong san sang - dung gia tri 0");
  }
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
  if (!_ready || !_scale.is_ready()) {
    return _ema;
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
