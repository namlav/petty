#include "motor_control.h"

void MotorControl::begin() {
  pinMode(PIN_ENABLE, OUTPUT);
  pinMode(PIN_LIMIT_SW, INPUT_PULLUP);
  _enable(false);  // A4988 ENABLE active-low: HIGH = ngắt động cơ
  _stepper.setMaxSpeed(STEPPER_MAX_SPEED);
  _stepper.setAcceleration(STEPPER_ACCEL);
  _stepper.setCurrentPosition(0);
}

void MotorControl::_enable(bool on) {
  // ENABLE của A4988 active-low.
  digitalWrite(PIN_ENABLE, on ? LOW : HIGH);
}

void MotorControl::_halt() {
  _stepper.setSpeed(0);
  _stepper.moveTo(_stepper.currentPosition());
}

void MotorControl::startFeed() {
  if (_state != MOTOR_IDLE) {
    return;
  }
  _retry = 0;
  _jamEvent = false;
  _enable(true);
  _stepper.setMaxSpeed(STEPPER_MAX_SPEED);
  _stepper.setAcceleration(STEPPER_ACCEL);
  _stepper.move((long)STEPPER_STEPS_PER_REV * 10);  // quay thuận liên tục
  _cycleStart = millis();
  _state = MOTOR_FEEDING;
  Serial.println("[MOTOR] Bat dau xa hat");
}

void MotorControl::stop() {
  if (_state == MOTOR_JAMMED) {
    return;
  }
  _halt();
  _enable(false);
  _state = MOTOR_IDLE;
  _retry = 0;
}

void MotorControl::update() {
  switch (_state) {
    case MOTOR_FEEDING:
      _stepper.run();
      if (digitalRead(PIN_LIMIT_SW) == LOW) {
        _halt();
        _enable(false);
        _state = MOTOR_IDLE;
        Serial.println("[MOTOR] LIMIT_SW cham - hoan tat 1 chu ky xa");
      } else if (millis() - _cycleStart >= FEED_TIMEOUT_MS) {
        // Qua 2.5s chua co phan hoi hanh trinh => nghi ket, lui 60 do.
        _halt();
        _stepper.setMaxSpeed(STEPPER_MAX_SPEED / 2);
        _stepper.moveTo(_stepper.currentPosition() - RETRACT_STEPS);
        _state = MOTOR_RETRACTING;
        Serial.printf("[MOTOR] Timeout - lui %d buoc de giai phong hat\n",
                      RETRACT_STEPS);
      }
      break;

    case MOTOR_RETRACTING:
      _stepper.run();
      if (_stepper.distanceToGo() == 0) {
        _retry++;
        if (_retry >= MAX_RETRY) {
          _enable(false);
          _state = MOTOR_JAMMED;
          _jamEvent = true;
          Serial.println("[MOTOR] ERR_JAM - da thu 3 lan, ngat dong co");
        } else {
          Serial.printf("[MOTOR] Thu lai lan %u\n", (unsigned)_retry + 1);
          _cycleStart = millis();
          _stepper.setMaxSpeed(STEPPER_MAX_SPEED);
          _stepper.move((long)STEPPER_STEPS_PER_REV * 10);
          _state = MOTOR_FEEDING;
        }
      }
      break;

    default:
      break;
  }
}

bool MotorControl::consumeJamEvent() {
  if (!_jamEvent) {
    return false;
  }
  _jamEvent = false;
  return true;
}

void MotorControl::clearJam() {
  if (_state != MOTOR_JAMMED) {
    return;
  }
  _halt();
  _enable(false);
  _state = MOTOR_IDLE;
  _retry = 0;
  _jamEvent = false;
  Serial.println("[MOTOR] Da xoa loi ket hat");
}
