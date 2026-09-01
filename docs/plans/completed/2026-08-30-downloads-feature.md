# Downloads feature

Работает стабильно.

## Выполнено

- SABR notification получила per-download actions: `Pause`, `Resume`, `Retry`, `Cancel`.
- Pause сохраняет `paused` и `interrupted`, Resume/Retry возвращают загрузку в queue.
- `PendingIntent` использует отдельный request ID для каждой пары download/action.
- Добавлены automated tests для notification payloads, actions и deterministic IDs.
- Проверены на `ZY32KFTHMV`: параллельные SABR downloads, точные bytes/total/speed, notification actions и pause state.
- Native progressive/adaptive paths покрыты существующими tests. Текущий device endpoint отдаёт только SABR formats, поэтому отдельный native MP4 device matrix недоступен без backend fixture с native formats.

## Что улучшить

Нет.
