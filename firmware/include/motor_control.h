#pragma once

#include <Arduino.h>
#include <AccelStepper.h>

#include "config.h"

// ============================================================
// [SV1] Điều khiển Stepper xả hạt + phản hồi LIMIT_SW chống kẹt
// ============================================================
enum MotorState : uint8_t {
  MOTOR_IDLE = 0,
  MOTOR_FEEDING,
  MOTOR_RETRACTING,
  MOTOR_JAMMED,
};

class MotorControl {
 public:
  void begin();
  void startFeed();
  void stop();  // dừng khẩn cấp (nút STOP / lệnh remote)
  void update();

  bool isFeeding() const {
    return _state == MOTOR_FEEDING || _state == MOTOR_RETRACTING;
  }
  bool isJammed() const { return _state == MOTOR_JAMMED; }
  bool consumeJamEvent();  // true đúng 1 lần sau khi kẹt hạt
  void clearJam();
  MotorState state() const { return _state; }
  uint8_t retryCount() const { return _retry; }

 private:
  AccelStepper _stepper{AccelStepper::DRIVER, PIN_STEP, PIN_DIR};
  MotorState _state = MOTOR_IDLE;
  uint32_t _cycleStart = 0;
  uint8_t _retry = 0;
  bool _jamEvent = false;

  void _enable(bool on);
  void _halt();
};
