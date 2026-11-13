#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <ESP32Servo.h>

#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, -1);

Servo feederServo;

// Định nghĩa chân kết nối
const int PIN_SERVO      = 19;
const int PIN_TRIG       = 5;
const int PIN_ECHO       = 18;
const int PIN_BTN_FEED   = 25;
const int PIN_BTN_STOP   = 26;
const int PIN_BUZZER     = 27;
const int PIN_LED_GREEN  = 14;
const int PIN_LED_RED    = 13;
const int PIN_POT_BOWL   = 34; // ADC giả lập trọng lượng bát

// Biến trạng thái
bool isFeeding = false;
unsigned long feedStartTime = 0;
const unsigned long FEED_DURATION = 2500; // Mở xả hạt trong 2.5 giây

void setup() {
  Serial.begin(115200);

  pinMode(PIN_TRIG, OUTPUT);
  pinMode(PIN_ECHO, INPUT);
  pinMode(PIN_BTN_FEED, INPUT_PULLUP);
  pinMode(PIN_BTN_STOP, INPUT_PULLUP);
  pinMode(PIN_BUZZER, OUTPUT);
  pinMode(PIN_LED_GREEN, OUTPUT);
  pinMode(PIN_LED_RED, OUTPUT);

  feederServo.attach(PIN_SERVO);
  feederServo.write(0); // Đóng khay

  digitalWrite(PIN_LED_GREEN, HIGH); // Báo nguồn sẵn sàng
  digitalWrite(PIN_LED_RED, LOW);

  if(!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
    Serial.println(F("Khởi tạo OLED thất bại"));
    for(;;);
  }

  display.clearDisplay();
  display.setTextColor(WHITE);
  display.setTextSize(1);
  display.setCursor(15, 25);
  display.print("PET FEEDER IoT");
  display.display();
  delay(1200);
}

// Đo khoảng cách cảm biến siêu âm (cm)
float readDistance() {
  digitalWrite(PIN_TRIG, LOW);
  delayMicroseconds(2);
  digitalWrite(PIN_TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(PIN_TRIG, LOW);
  long duration = pulseIn(PIN_ECHO, HIGH, 30000);
  if (duration == 0) return 30.0;
  return duration * 0.034 / 2;
}

// Gọi thú cưng lại ăn bằng còi
void callPetSound() {
  for (int i = 0; i < 2; i++) {
    tone(PIN_BUZZER, 1800, 150);
    delay(200);
  }
}

void loop() {
  // 1. Đọc dữ liệu cảm biến
  float dist = readDistance();
  // Giả định chiều cao bình chứa là 30cm: gần = đầy (100%), xa = cạn (0%)
  int foodPercent = map(constrain((int)dist, 4, 30), 30, 4, 0, 100);

  // Đọc trọng lượng bát ăn (0 - 200 gam) từ biến trở
  int potVal = analogRead(PIN_POT_BOWL);
  int bowlWeight = map(potVal, 0, 4095, 0, 200);

  // 2. Cảnh báo hết thức ăn trong bình
  bool lowFood = (foodPercent < 15);
  if (lowFood && !isFeeding) {
    digitalWrite(PIN_LED_RED, HIGH); // Sáng đèn cảnh báo cạn thức ăn
  } else if (!isFeeding) {
    digitalWrite(PIN_LED_RED, LOW);
  }

  // 3. Xử lý nút bấm DỪNG KHẨN CẤP (STOP)
  if (digitalRead(PIN_BTN_STOP) == LOW) {
    if (isFeeding) {
      feederServo.write(0);
      isFeeding = false;
      noTone(PIN_BUZZER);
      digitalWrite(PIN_LED_RED, LOW);
      Serial.println("[ALERT] Dừng khẩn cấp!");
      delay(300);
    }
  }

  // 4. Xử lý nút bấm CHO ĂN (FEED)
  if (digitalRead(PIN_BTN_FEED) == LOW && !isFeeding) {
    // Logic chống tràn: Nếu bát đã có hơn 120g thì chặn không nhả thêm
    if (bowlWeight > 120) {
      Serial.println("[TỪ CHỐI] Bát ăn vẫn còn đầy, chống tràn kích hoạt!");
      tone(PIN_BUZZER, 400, 500); // Kêu tiếng trầm báo lỗi
      for(int i=0; i<3; i++) {
        digitalWrite(PIN_LED_RED, HIGH);
        delay(80);
        digitalWrite(PIN_LED_RED, LOW);
        delay(80);
      }
    } else {
      Serial.println("[ACTION] Đang nhả thức ăn...");
      isFeeding = true;
      feedStartTime = millis();
      callPetSound();
      feederServo.write(90); // Mở góc nhả hạt
    }
    delay(200);
  }

  // 5. Kiểm tra thời gian đóng van xả tự động
  if (isFeeding && (millis() - feedStartTime >= FEED_DURATION)) {
    feederServo.write(0); // Đóng van
    isFeeding = false;
    Serial.println("[SUCCESS] Hoàn tất chu trình cho ăn.");
  }

  // 6. Cập nhật thông số lên màn hình OLED
  display.clearDisplay();
  
  display.setTextSize(1);
  display.setCursor(0, 0);
  display.print("HE THONG CHO THU CUNG");
  display.drawLine(0, 10, 128, 10, WHITE);

  display.setCursor(0, 16);
  display.print("Thung chua: ");
  display.print(foodPercent);
  display.print(" %");

  display.setCursor(0, 30);
  display.print("Bat an    : ");
  display.print(bowlWeight);
  display.print(" g");

  display.setCursor(0, 48);
  if (isFeeding) {
    display.print("TRANG THAI: DANG CHO AN");
  } else if (lowFood) {
    display.print("TRANG THAI: CAN THUC AN");
  } else if (bowlWeight > 120) {
    display.print("TRANG THAI: BAT CON DAY");
  } else {
    display.print("TRANG THAI: SAN SANG");
  }

  display.display();
  delay(100);
}