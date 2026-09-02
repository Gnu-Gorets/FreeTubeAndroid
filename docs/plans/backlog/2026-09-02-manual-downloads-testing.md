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

## Acceptance checks

- Все сценарии выше пройдены вручную.
- Для каждого найденного бага есть шаги воспроизведения и automated regression check.
- Smoke suite стабильно проходит два последовательных запуска.
- Notification и экран `Downloads` показывают одинаковый terminal state.
- Проверены одиночные и параллельные загрузки.

## Ограничения и отдельные задачи

- Нужна отдельная deterministic fixture для быстрого completion test вместо больших live YouTube downloads.
- Нужно стабилизировать `downloads-page` и `download-delete` smoke checks.
- Playback скачанных файлов отдельно не проверялся.
