# План тестирования Downloads на Android

## Цель

Проверить Downloads на физическом Android-устройстве: 5-минутное видео, разные качества и formats, notification shade, pause/resume, cancel/delete, retry, network interruption, storage, restart и offline playback.

## Тестовое окружение

- Device: `ZY32KFTHMV`, `moto g34 5G`, Android user `0`.
- APK: debug build, собирается в Docker.
- Smoke runner: `_scripts/android-smoke-test.sh`.
- Основные файлы: `src/renderer/helpers/android/downloads.js`, `src/renderer/views/Watch/Watch.js`, `src/renderer/views/Downloads/Downloads.vue`, `android/app/src/main/java/io/freetubeapp/freetubeandroid/DownloadService.kt`, `AndroidBridge.kt`.

## План тестирования

### 1. Видео и качество

Использовать:

- видео длительностью около 5 минут;
- короткое видео;
- видео с progressive, adaptive и SABR formats;
- минимум три доступных качества;
- title с Unicode, длинной строкой и filename-unsafe символами.

Проверить:

- quality picker появляется при нескольких вариантах;
- выбор минимального, среднего и максимального качества;
- progressive и adaptive formats;
- SABR с разными `maxHeight`;
- отмена picker не создаёт download;
- выбранное качество сохраняется в metadata, UI и notification;
- adaptive результат содержит video и audio и воспроизводится.

### 2. Скачивание и notification

Во время загрузки 5-минутного видео проверить:

- `downloading` в Downloads page;
- progress, received, total, speed и ETA;
- монотонный progress в диапазоне `0..100%`;
- notification в верхней шторке;
- title, percent, bytes, speed и actions `Pause`/`Cancel`.

После завершения проверить:

- статус `completed`;
- notification `Download complete`;
- отсутствие stale progress actions;
- корректный размер и воспроизведение файла.

### 3. Pause, resume, cancel и delete

Проверить действия из Downloads page и notification:

- `Pause` останавливает bytes и переводит запись в `paused`;
- `Resume` продолжает тот же download;
- `Cancel` останавливает network request;
- canceled partial file удаляется или остаётся корректным retry target;
- `Delete` active download одновременно вызывает cancel;
- `Delete` completed progressive удаляет MediaStore item;
- `Delete` completed SABR удаляет Shaka offline storage;
- после удаления entry исчезает из UI, metadata и queue.

### 4. Обрыв сети и retry

На 5-минутной загрузке:

1. Отключить Wi-Fi и cellular/data.
2. Проверить сохранение уже записанных bytes и partial target.
3. Включить сеть и нажать `Resume`.
4. Проверить Range offset, отсутствие удвоения файла и совпадение итоговых size/checksum.
5. Повторить после force-stop и process death.
6. Проверить retry после timeout, HTTP 408/429/5xx и expired media URL.
7. Проверить ответ `200` вместо `206`: файл должен перезаписываться, а не append-иться.

### 5. Storage и filenames

Проверить:

- public files находятся в `Download/FreeTube/`;
- MediaStore `is_pending=0` выставляется только после completion;
- финальное имя имеет одно `.mp4` и не содержит `.part.mp4`;
- SAF/Documents target финализируется без MediaStore `IS_PENDING`;
- cancel picker, missing permission, deleted target и insufficient storage дают понятный error;
- после cancel/delete не остаются orphan files, notifications, connections и cache files.

### 6. UI, persistence и playback

Проверить:

- empty state и search по title, video ID, status, quality и path;
- кнопки по статусам:
  - `downloading`: Pause, Cancel, Delete;
  - `paused`: Resume, Cancel, Delete;
  - `failed`: Retry, Delete;
  - `completed`: Play, Delete;
  - `canceled`: Delete;
- restart Activity/app и восстановление queue, metadata, progress и quality;
- offline playback progressive, adaptive и SABR без сети;
- audio, seek, subtitles, chapters и thumbnail;
- `.part` и failed files не воспроизводятся как completed;
- пять parallel downloads не смешивают IDs, files, progress и actions.

### 7. Android lifecycle

Проверить Downloads во время background, locked screen, force-stop, Activity recreation и process death. Проверить `adb logcat` на native/WebView errors и корректное состояние foreground service.

## Acceptance checks

- 5-минутное видео и минимум три видео разных qualities/formats успешно скачаны.
- Quality picker, selected quality, progress и notification подтверждены на устройстве.
- Public files находятся в `Download/FreeTube/`, имеют одно `.mp4` и воспроизводятся после restart и без сети.
- Pause, Resume, Retry, Cancel и Delete проверены из UI и notification.
- Wi-Fi interruption/resume завершён без потери bytes, удвоения файла и с совпадающим checksum.
- Проверены SAF, process death, parallel downloads, filename sanitization и cleanup.
- Automated tests и Android smoke suite проходят без failures.

## Реализованное smoke coverage

В `_scripts/android-smoke-test.sh` добавлены:

- `downloads-page`;
- `download-quality`;
- `download-notification`;
- `download-storage`;
- `download-cancel`;
- `download-delete`;
- `dump_ui()` и `tap_ui_text()` для действий по UI text.

Smoke проверяет quality picker, notification shade, public MediaStore path, completed downloads page и runtime errors. `download-cancel` и `download-delete` пропускаются, если устройство не успело создать подходящий fixture.

## Последний результат

- APK собран в Docker и установлен на `ZY32KFTHMV`, user `0`.
- Full unlocked smoke:

```text
PASS=18 FAIL=0 SKIP=2
```

- SKIP:
  - короткое видео завершилось до проверки `Cancel`;
  - отсутствовал completed metadata fixture для `Delete`.
- Downloads checks `downloads-page`, `download-quality`, `download-notification` и `download-storage` прошли.
- Node downloads suite: `34 passed, 0 failed`.
- Остались ограничения: нет deterministic long-video/HTTP fixture для interruption/resume и component harness для настоящего DOM event testing.
