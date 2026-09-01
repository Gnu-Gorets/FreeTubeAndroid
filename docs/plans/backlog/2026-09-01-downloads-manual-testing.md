# Ручное тестирование Downloads на Android

## Цель

Проверить на физическом Android-устройстве загрузку разных видео, расположение готовых файлов, обработку обрывов и докачку после восстановления Wi-Fi. Отдельно проверить сценарии, которые не покрыты automated tests.

## Контекст и источники

- Репозиторий: `FreeTubeAndroid`.
- Базовый план: `docs/plans/backlog/2026-08-30-downloads-feature.md`.
- Устройство: `ZY32KFTHMV`, `moto g34 5G`, Android user `0`.
- Установленный APK: `0.1.0-local`, `versionCode=1`.
- Реализация: `src/renderer/helpers/android/downloads.js`, `android/app/src/main/java/io/freetubeapp/freetubeandroid/DownloadService.kt`, `android/app/src/main/java/io/freetubeapp/freetubeandroid/AndroidBridge.kt`.
- Automated command: `pnpm test:downloads` не запустился, потому что в окружении отсутствует `pnpm` (`command not found`).

## Выполненные проверки

### 1. Progressive video и расположение файла

Шаги:

1. Открыто видео `Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)` через прямой YouTube URL.
2. Нажата кнопка Download.
3. Вместо автоматического public target открылся Android Documents picker.
4. Файл сохранён в `Documents` с именем `...mp4.part.mp4`.

Результат:

- В UI Downloads запись получила статус `failed`, формат `progressive`, действие `Retry`.
- В `Documents` остался файл размером `11829048` байт.
- В MediaStore файл виден как:
  - `relative_path=Documents/`
  - `is_pending=0`
  - имя заканчивается на `.mp4.part.mp4`
- В `Download/FreeTube` файл не появился.
- Фактически HTTP-загрузка завершила все байты, но финализация загрузки завершилась ошибкой. Это оставляет мусорный файл и даёт ложный статус `failed`.

### 2. Разные типы загрузок

По экрану Downloads подтверждена ранее сохранённая SABR-загрузка:

- `CAT GAMES - Catching Mice! ...`
- статус `completed`
- формат `240p (SABR)`

В native queue и app-private storage также обнаружены завершённые progressive-загрузки с target вида `data://downloads/FreeTube/...`. Они лежат в app-private `files/data/downloads`, а не в публичном `Download/FreeTube`.

Вывод: SABR и старый app-private progressive path визуально работают, но требование публичной папки не подтверждено. Новый progressive сценарий через fallback picker воспроизводимо ломается на финализации.

### 3. Прерывание и докачка после Wi-Fi

Не выполнено end-to-end:

- первая progressive-загрузка завершилась ошибкой после получения полного размера;
- после этого тестировать обрыв и Resume на том же target нельзя, так как UI пометил запись как `failed`, а оставшийся target уже не является корректно финализированной `.part`-загрузкой;
- стабильный повторный прогон требует сначала исправить создание public target и финализацию `content://` URI.

## Найденная проблема и root-cause гипотеза

### Симптом

Полный файл скачан, но Downloads показывает `failed`; файл находится в `Documents`, имеет двойное расширение и отсутствует в `Download/FreeTube`.

### 5 Why

1. Почему статус `failed`? Ошибка возникает после записи байтов, в завершающей native-обработке target URI.
2. Почему target оказался в `Documents`? `createDownloadFile()` вернул пустой результат, поэтому renderer использовал `requestSaveDialog()`.
3. Почему picker создал `.part.mp4`? Renderer передал имя `fileName.part`, а Documents provider добавил выбранный MIME extension `.mp4`.
4. Почему fallback target обрабатывается неправильно? `DownloadService` безусловно вызывает `publish()` для любого `content://` URI, хотя `IS_PENDING` относится к MediaStore target, а URI из Documents provider не является MediaStore pending item.
5. Почему ошибка не видна как частично успешная загрузка? Native queue сохраняет финальный exception как `failed`, не проверяет результат `DocumentFile.renameTo()`, а renderer оставляет созданный target при native queue failure.

Корневая область дефекта: смешаны два storage contract для MediaStore и SAF `DocumentsContract`, а fallback picker не имеет отдельного пути финализации и cleanup.

## Что проверить после исправления

1. `createDownloadFile("data://downloads/FreeTube", ...)` возвращает MediaStore URI.
2. Обычное progressive video появляется в `Download/FreeTube` с одним `.mp4` расширением.
3. Adaptive/native MP4 и SABR сохраняются и воспроизводятся из Downloads.
4. Ошибка до начала загрузки удаляет target и оставляет понятный `failed` без мусорного файла.
5. Ошибка после частичной записи сохраняет `.part`, статус `paused` или `failed` с рабочим `Resume`/`Retry`.
6. После отключения Wi-Fi во время загрузки:
   - прогресс останавливается;
   - уже записанные bytes не теряются;
   - после включения Wi-Fi Resume продолжает с Range offset;
   - итоговый размер и checksum совпадают с исходным файлом.
7. При серверном ответе `200` вместо `206` после Range запрос не происходит ошибочного удвоения файла.
8. Повторный Retry не создаёт дубликаты и не использует устаревший expired media URL без повторного получения formats.
9. Pause/Resume/Retry/Cancel из notification и из Downloads page синхронно обновляют queue и UI.
10. Перезапуск приложения и Android process death восстанавливают interrupted queue без потери metadata.
11. Параллельные загрузки не смешивают target URI, notification ID, прогресс или финальные имена.
12. Недостаток места, отсутствие разрешения на SAF target, отмена picker и удаление файла из Documents provider дают корректный error state.
13. Offline playback работает после завершения, а незавершённый `.part` не показывается как воспроизводимый файл.

## Acceptance checks

- `pnpm test:downloads` проходит.
- На `ZY32KFTHMV`, user `0`, минимум три видео разных длительностей и форматов успешно скачаны.
- Все public downloads находятся в `Download/FreeTube`, имеют финальное имя `.mp4`, воспроизводятся после перезапуска приложения.
- Отдельный Wi-Fi interruption/resume сценарий завершён без потери уже скачанных bytes.
- В `adb logcat` нет ошибок `FreeTubeDownload`, связанных с успешными загрузками.
- Результаты повторно записаны в этот plan; до исправления дефекта plan остаётся в `docs/plans/backlog/`.

## Реализация и повторная проверка

Исправления:

- `AndroidBridge.createDownloadFile()` теперь использует `MediaStore.Downloads`, а не `MediaStore.Video.Media`: Android phone запрещал `Download` как `RELATIVE_PATH` для video collection.
- `DownloadService.publish()` применяет `IS_PENDING` только к MediaStore URI.
- MediaStore filename обновляется через `DISPLAY_NAME`; `DocumentFile.renameTo()` используется только для SAF URI.
- Проверка существования target при восстановлении учитывает app-private `data://` files.
- Fallback SAF save dialog получает имя `fileName`, без двойного `.part.mp4` расширения.
- Ошибка rename больше не игнорируется.

Результат ручной проверки после сборки APK в Docker:

- `Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)` успешно скачан.
- UI Downloads показывает `completed`, `progressive`, доступны `Play` и `Delete`.
- MediaStore подтверждает `relative_path=Download/FreeTube/`, `_size=11829048`, `is_pending=0`, имя с одним `.mp4`.
- Ранее созданные ошибочные записи сохранены как исторические `failed`/`canceled` и не маскируют новую успешную запись.
- SAF fallback также повторно завершился с `completed` в выбранном `Documents` target.
- Wi-Fi interruption/resume end-to-end после фикса не завершён: короткое видео успевает завершиться до отключения сети; нужен отдельный длинный media fixture или контролируемое throttling для воспроизводимого обрыва.

Проверки:

- Docker `pnpm install --frozen-lockfile`: passed.
- Docker `pnpm run pack:android:dev`: passed.
- Docker `./gradlew assembleDebug`: passed.
- Docker `pnpm test:downloads` и playback/notification tests: 22 passed.
- Docker `pnpm run lint`: passed.
- Docker `pnpm run lint-json`: passed.
- Docker `pnpm run lint-yml`: passed with 2 pre-existing warnings in `static/locales/ar.yaml`.
- Docker `pnpm run checkforbadtemplates`: completed with existing locale findings, no command failure.
- Android smoke `unlocked`: partial run, `cold-start`, `search`, `playback`, `controls`, `audio-focus`, `persistence` passed; `export` и `data-directory-cancel` failed on existing device state, run timed out at `data-directory-move-reset`.

## Расширенное покрытие automated tests

Добавлены проверки в `tests/downloads.test.mjs` и `tests/download-notification.test.mjs`.

Покрытые сценарии:

- выбор download quality: progressive, adaptive, лучший audio track, сортировка по высоте, отбрасывание invalid formats;
- SABR quality picker: deduplication, labels `240p/480p/720p`, выбор максимального доступного качества, invalid manifest;
- quality picker UI flow в `Watch.js`: появление options при нескольких форматах и передача выбранного формата в download handler;
- notification во время скачивания: initial progress, bytes, total, speed, pause/cancel actions;
- notification после завершения и отмены: отсутствие recovery actions;
- paused и failed notification: Resume/Cancel и Retry;
- clamping progress в диапазон `0..100`;
- metadata update, сохранение channel/playback details и отсутствие изменения чужой записи;
- native queue progress, stale fields, missing total и SABR progress snapshots;
- cancel/pause/resume/retry/delete/play flows в Downloads view;
- native notification action intents и deterministic IDs;
- MediaStore Downloads collection, `IS_PENDING`, MediaStore rename и SAF finalization contracts;
- offline playback source selection.

Итоговый downloads-focused запуск:

```text
node --test tests/downloads.test.mjs tests/download-notification.test.mjs tests/playback-source.test.mjs
34 passed, 0 failed
```

Во время добавления тестов был обнаружен только тестовый дефект: массивы из `vm` имеют другой realm, поэтому прямой `deepEqual` ошибочно падал при одинаковой структуре. Проверки исправлены через JSON normalization. Product regression по quality picker, notification actions или cancel/delete automated tests не обнаружили.

Оставшиеся проблемы и ограничения:

- Тесты quality picker и Downloads view сейчас source/contract-based, без component harness и реального DOM event dispatch.
- Native Kotlin queue не имеет unit-test harness для HTTP `206/200`, partial file, retry и process death.
- Нет deterministic local HTTP fixture для проверки Wi-Fi interruption/resume, Range offset и checksum.
- Для проверки notification сверху в Android shade по-прежнему нужен device-driven сценарий, а не только payload tests.
- Полный `android-smoke-test.sh --suite unlocked` остаётся нестабильным на загрязнённом устройстве: ранее зафиксированы failures `export`, `data-directory-cancel` и timeout на `data-directory-move-reset`.

## Android smoke coverage для Downloads

В `_scripts/android-smoke-test.sh` добавлены device-driven checks:

- `downloads-page`: открытие Downloads page, screenshot и проверка отсутствия runtime errors;
- `download-quality`: реальный Watch flow для `Me at the zoo`, нажатие Download и проверка quality picker через `uiautomator` XML; на устройстве обнаружены `240p (SABR)` и `144p (SABR)`;
- `download-notification`: запуск download flow, проверка package notification в `dumpsys notification`, раскрытие верхней шторки и screenshot;
- `download-cancel`: переход в Downloads во время active download, поиск `Cancel` и проверка `canceled`; на текущем устройстве загрузка завершается до появления Cancel, поэтому test корректно отмечается `SKIP`;
- `download-delete`: удаление completed download через UI text lookup и проверка исчезновения completed entry; после `data-directory-move-reset` fixture отсутствует, поэтому test корректно отмечается `SKIP`.

Добавлены `dump_ui()` и `tap_ui_text()`, чтобы не привязывать cancel/delete к фиксированным координатам.

Результат полного запуска:

```text
_scripts/android-smoke-test.sh --serial ZY32KFTHMV --suite unlocked --timeout 20
PASS=14 FAIL=3 SKIP=2
```

Downloads checks:

```text
downloads-page     PASS
download-quality   PASS
download-notification PASS
download-cancel    PASS with SKIP: download completed before cancel action became available
download-delete    PASS with SKIP: no completed download fixture on device
```

Новые проблемы и ограничения, подтверждённые smoke:

- `download-cancel` не получает активный fixture: выбранное видео слишком короткое, native download завершается раньше UI cancel action. Нужен длинный test video или controllable local fixture.
- `download-delete` зависит от completed metadata fixture и пропускается после очистки/переноса data directory. Нужен setup, который создаёт короткий гарантированно completed download перед проверкой.
- `downloads-page` нельзя проверять только по WebView `uiautomator` text: WebView иногда отдаёт пустой text tree. Поэтому проверка использует screenshot и runtime logs.
- Качество picker реально проверен на device, но test принимает SABR labels как критерий. Для проверки выбора конкретного quality нужно ещё нажать option и проверить `selectedFormat`/notification.
- Во время первого полного прогона после добавления Downloads tests повторились failures `export`, `data-directory-cancel`, `data-directory-move-reset`: координаты были рассчитаны для старого layout и не соответствовали экрану Data settings. Исправлены координаты `Export Playlists` и `Select/Reset Data Directory`.

## Повторный Android smoke run

После исправления smoke harness:

- APK пересобран в Docker через `pnpm install --frozen-lockfile`, `pnpm run pack:android:dev`, `./gradlew assembleDebug`.
- APK установлен на `ZY32KFTHMV`, Android user `0`.
- Полный unlocked suite повторно пройден успешно:

```text
PASS=18 FAIL=0 SKIP=2
```

Успешно прошли все обычные и Downloads checks: `export`, `data-directory-cancel`, `data-directory-move-reset`, `downloads-page`, `download-quality`, `download-notification`, `download-storage`, `cleanup`, `recovery`.

Ожидаемые skips:

- `download-cancel`: короткое видео скачалось до появления active `Cancel` action;
- `download-delete`: после reset data directory нет completed metadata fixture.

Downloads smoke теперь также проверяет наличие готового non-pending `.mp4` в `Download/FreeTube/` через MediaStore и наличие download-specific text в notification dump.
