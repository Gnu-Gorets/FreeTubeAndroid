# План тестирования Android downloads

## Цель

Протестировать downloads flow вручную на физическом телефоне, найти баги в Android notification shade и покрыть воспроизводимые сценарии автоматическими smoke checks.

## Ручные сценарии

1. Запустить загрузку и проверить notification: title видео, quality, progress, speed и actions.
2. Проверить, имеет ли смысл держать notification раскрытой по умолчанию: читаемость title, progress и actions.
3. Отменить загрузку внутри app и проверить автоматическое исчезновение notification из шторки.
4. Дождаться успешного завершения и проверить автоматическое исчезновение notification без ручного закрытия и перезапуска app.
5. Запустить 2-3 загрузки разных видео и качеств; наблюдать несколько минут grouping, title каждой строки, progress, ordering и terminal state.
6. Сверить шторку с экраном `Downloads`: файл, title, thumbnail, quality и статус должны совпадать.
7. Проверить pause, resume, cancel, retry, Play и Delete.
8. Повторить проверки после закрытия/перезапуска app и при свёрнутом app.

## Автоматизация

- Добавить smoke checks для каждого воспроизводимого бага.
- Проверять notification через `adb shell dumpsys notification --noredact` и screenshots/UI state.
- Проверять экран `Downloads` через UI dump.
- Использовать короткие deterministic downloads для completion/cancel сценариев.
- Прогонять проверки на physical device user `0`.

## План изменений после тестирования

### Deterministic fixture

- Добавить короткий deterministic HTTPS fixture для маленького MP4 вместо live YouTube download.
- Использовать fixture для completion, cancel, pause/resume и retry сценариев.
- Добавить управляемое замедление или достаточно большой fixture для гарантированного окна cancel/pause.
- Не добавлять отдельную production-зависимость: fixture должна использоваться только smoke test flow.

### Android download flow

- В `android/app/src/main/java/io/freetubeapp/freetubeandroid/DownloadService.kt` проверить и исправить state transitions `queued → downloading → paused/resumed/canceled/completed/failed`.
- Исправить lifecycle notifications: title, quality, progress, speed, actions, terminal cleanup и независимые notifications для параллельных загрузок.
- Проверить сохранение queue и восстановление после force-stop, закрытия и перезапуска app.
- Проверить cleanup target files, public storage state (`is_pending=0`), retry и корректное завершение service.

### Downloads UI и metadata

- В `src/renderer/views/Downloads/Downloads.vue` и `src/renderer/helpers/android/downloads.js` устранить рассинхронизацию native queue и `localStorage`.
- Проверить native и SABR paths для pause/resume/cancel/retry.
- Обеспечить одинаковые `title`, `thumbnail`, `quality`, file URI и status на экране `Downloads` и в notification.
- Проверить Play и Delete: удаление metadata, native/SABR файла и связанной notification.

### Smoke checks

- Расширить `_scripts/android-smoke-test.sh` проверками всех воспроизводимых багов и ручных сценариев: notification fields/actions, cancel/completion cleanup, pause/resume/retry, grouping, parallel downloads, restart/background recovery, Downloads screen parity, Play, Delete и public storage.
- Использовать UI dump и content descriptions вместо fixed coordinates, где это возможно.
- Заменить fixed timing на polling ожидаемого state transition с timeout.
- Запускать UI-driven checks последовательно, чтобы не получать конфликт `UiAutomationService`.
- Для каждого найденного бага добавить reproduction steps и отдельный regression check в этот план.

## Acceptance checks

- Все сценарии выше пройдены вручную.
- Для каждого найденного бага есть шаги воспроизведения и automated regression check.
- Smoke suite стабильно проходит два последовательных запуска.
- Notification и экран `Downloads` показывают одинаковый terminal state.
- Проверены одиночные и параллельные загрузки.
- Completion, cancel, pause/resume и retry используют deterministic fixture и не зависят от скорости live YouTube.
- После restart/background/force-stop queue, files, metadata и notifications остаются согласованными.

## Ограничения и отдельные задачи

- Нужна отдельная deterministic fixture для быстрого completion test вместо больших live YouTube downloads.
- Нужно стабилизировать `downloads-page` и `download-delete` smoke checks.
- Playback скачанных файлов отдельно не проверялся.

## Выполнено

- В `_scripts/android-smoke-test.sh` добавлен `clean_logs` перед `downloads-page`, чтобы старые runtime errors не ломали проверку.
- `download-delete` теперь находит первую кнопку `Delete` через текущий UI dump вместо фиксированных координат.
- На physical device `ZY32KFTHMV`, Android user `0`, два последовательных прогона `--suite downloads` завершились `PASS=9 FAIL=0 SKIP=1`.
- `download-cancel` пропущен, потому что live download завершился раньше доступного действия.
- Параллельный запуск UI dump выявил конфликт `UiAutomationService already registered`; smoke suite нужно запускать последовательно.

## Проверки

- `bash -n _scripts/android-smoke-test.sh` пройден.
- `adb devices -l`, `adb get-state`, `adb shell am get-current-user` пройдены: устройство `ZY32KFTHMV`, state `device`, user `0`.

## Осталось

- Реализовать deterministic fixture и перевести на неё completion/cancel/pause/resume/retry checks.
- Проверить и при необходимости исправить `DownloadService.kt`, `Downloads.vue` и `downloads.js` по результатам ручных сценариев.
- Дополнить smoke suite polling-based checks для всех сценариев.
- Выполнить ручные сценарии из раздела «Ручные сценарии», включая pause/resume/retry/Play/Delete, grouping и restart/background.
- Отдельно проверить playback скачанного файла.
