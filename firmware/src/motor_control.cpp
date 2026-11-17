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
  portENTER_CRITICAL(&_mux);
  if (_state != MOTOR_IDLE) {
    portEXIT_CRITICAL(&_mux);
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
  portEXIT_CRITICAL(&_mux);
  Serial.println("[MOTOR] Bat dau xa hat");
}

void MotorControl::stop() {
  portENTER_CRITICAL(&_mux);
  if (_state == MOTOR_JAMMED) {
    portEXIT_CRITICAL(&_mux);
    return;
  }
  _halt();
  _enable(false);
  _state = MOTOR_IDLE;
  _retry = 0;
  portEXIT_CRITICAL(&_mux);
}

void MotorControl::update() {
  portENTER_CRITICAL(&_mux);
  const MotorState curState = _state;
  const bool simJam = _simJam;
  portEXIT_CRITICAL(&_mux);

  switch (curState) {
    case MOTOR_FEEDING: {
      portENTER_CRITICAL(&_mux);
      if (_state != MOTOR_FEEDING) {
        portEXIT_CRITICAL(&_mux);
        return;
      }
      _stepper.run();
      if (!simJam && digitalRead(PIN_LIMIT_SW) == LOW) {
        _halt();
        _enable(false);
        _state = MOTOR_IDLE;
        portEXIT_CRITICAL(&_mux);
        Serial.println("[MOTOR] LIMIT_SW cham - hoan tat 1 chu ky xa");
#ifdef PETTY_USE_WOKWI_PRIVATE_GW
      } else if (!simJam && millis() - _cycleStart >= 1800) {
        // Wokwi khong co hat roi that len loadcell; mac dinh hoan tat chu ky sau 1.8s.
        _halt();
        _enable(false);
        _state = MOTOR_IDLE;
        portEXIT_CRITICAL(&_mux);
        Serial.println("[MOTOR] Wokwi: hoan tat chu ky xa (khong ket)");
#endif
      } else if (millis() - _cycleStart >= FEED_TIMEOUT_MS) {
        // Qua 2.5s chua co phan hoi hanh trinh => nghi ket, lui 60 do.
        _halt();
        _stepper.setMaxSpeed(STEPPER_MAX_SPEED / 2);
        _stepper.moveTo(_stepper.currentPosition() - RETRACT_STEPS);
        _state = MOTOR_RETRACTING;
        portEXIT_CRITICAL(&_mux);
        Serial.printf("[MOTOR] Timeout - lui %d buoc de giai phong hat\n",
                      RETRACT_STEPS);
      } else {
        portEXIT_CRITICAL(&_mux);
      }
      break;
    }

    case MOTOR_RETRACTING: {
      portENTER_CRITICAL(&_mux);
      if (_state != MOTOR_RETRACTING) {
        portEXIT_CRITICAL(&_mux);
        return;
      }
      _stepper.run();
      if (_stepper.distanceToGo() == 0) {
        _retry++;
        if (_retry >= MAX_RETRY) {
          _enable(false);
          _state = MOTOR_JAMMED;
          _jamEvent = true;
          portEXIT_CRITICAL(&_mux);
          Serial.println("[MOTOR] ERR_JAM - da thu 3 lan, ngat dong co");
        } else {
          const uint8_t nextTry = (uint8_t)(_retry + 1);
          _cycleStart = millis();
          _stepper.setMaxSpeed(STEPPER_MAX_SPEED);
          _stepper.move((long)STEPPER_STEPS_PER_REV * 10);
          _state = MOTOR_FEEDING;
          portEXIT_CRITICAL(&_mux);
          Serial.printf("[MOTOR] Thu lai lan %u\n", (unsigned)nextTry);
        }
      } else {
        portEXIT_CRITICAL(&_mux);
      }
      break;
    }

    default:
      break;
  }
}

bool MotorControl::isFeeding() const {
  portENTER_CRITICAL(&_mux);
  const bool feeding = (_state == MOTOR_FEEDING || _state == MOTOR_RETRACTING);
  portEXIT_CRITICAL(&_mux);
  return feeding;
}

bool MotorControl::isJammed() const {
  portENTER_CRITICAL(&_mux);
  const bool jammed = (_state == MOTOR_JAMMED);
  portEXIT_CRITICAL(&_mux);
  return jammed;
}

void MotorControl::setSimulatedJam(bool on) {
  portENTER_CRITICAL(&_mux);
  _simJam = on;
  portEXIT_CRITICAL(&_mux);
}

bool MotorControl::simulatedJam() const {
  portENTER_CRITICAL(&_mux);
  const bool on = _simJam;
  portEXIT_CRITICAL(&_mux);
  return on;
}

bool MotorControl::consumeJamEvent() {
  portENTER_CRITICAL(&_mux);
  const bool fired = _jamEvent;
  _jamEvent = false;
  portEXIT_CRITICAL(&_mux);
  return fired;
}

void MotorControl::forceJam() {
  portENTER_CRITICAL(&_mux);
  _halt();
  _enable(false);
  _state = MOTOR_JAMMED;
  _jamEvent = true;
  portEXIT_CRITICAL(&_mux);
}

void MotorControl::clearJam() {
  portENTER_CRITICAL(&_mux);
  if (_state != MOTOR_JAMMED) {
    portEXIT_CRITICAL(&_mux);
    return;
  }
  _halt();
  _enable(false);
  _state = MOTOR_IDLE;
  _retry = 0;
  _jamEvent = false;
  portEXIT_CRITICAL(&_mux);
  Serial.println("[MOTOR] Da xoa loi ket hat");
}
