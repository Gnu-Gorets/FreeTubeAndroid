# Анализ различий Android-компоновки FreeTube

## Цель

Определить, почему мой APK показывает desktop-компоновку на телефоне, а чужой APK `io.freetubeapp.freetube` показывает mobile-компоновку, и найти минимальный исправляемый участок кода.

## Что проверено

Устройство: `ZY32KFTHMV`, physical display `720x1600`, Android user `0`.

| APK | Версия | Target SDK | Результат cold start |
|---|---:|---:|---:|
| `io.freetubeapp.freetubeandroid` | `0.1.0-local` | 36 | `Status: ok`, около 0.7-1.1 s |
| `io.freetubeapp.freetube` | `0.25.1.1` | 34 | `Status: ok`, около 1.2 s |

Скриншоты показали:

- мой APK: верхняя панель, широкая desktop-компоновка, нижняя навигация отсутствует как mobile layout;
- чужой APK: боковая/компактная mobile-компоновка и сетка видео в две колонки;
- после удаления desktop User-Agent override мой APK визуально не изменился;
- после добавления `useWideViewPort`, `loadWithOverviewMode` и пробного `setInitialScale(150)` визуально также ничего не изменилось.

Smoke test после сборки проходил:

```text
PASS=1 FAIL=0 SKIP=0
```

## Найденный исходник чужого форка

Чужой пакет соответствует проекту:

- GitHub: <https://github.com/MarmadileManteater/FreeTubeAndroid>
- исходная ветка для анализа: `development`
- проверенный commit: `c42fee2c7fb8bb0fd4aaf1798913779ce7d5d620`
- APK package id: `io.freetubeapp.freetube`

Ключевые файлы чужого проекта:

- `android/app/src/main/java/io/freetubeapp/freetube/webviews/FreeTubeWebView.kt`
- `android/app/src/main/java/io/freetubeapp/freetube/javascript/WebviewExtensions.kt`
- `android/app/src/main/java/io/freetubeapp/freetube/javascript/FreeTubeJavaScriptInterface.kt`
- `android/app/src/main/res/layout/activity_main.xml`
- `android/app/src/main/java/io/freetubeapp/freetube/MainActivity.kt`

## Корневая причина

Разница состоит из двух независимых частей. User-Agent не является причиной. Чужой форк тоже намеренно вызывает desktop User-Agent spoofing:

```kotlin
fun WebView.spoofDesktopUserAgent() {
  settings.userAgentString = settings.userAgentString
    .replace(Regex("Mozilla/5.0 \\([^)]*\\)"), "Mozilla/5.0 (X11; Linux x86_64)")
    .replace("Mobile Safari", "Safari")
}
```

Главное отличие находится в расчёте UI scale.

### Чужой форк

`WebviewExtensions.kt`:

```kotlin
fun WebView.setScale(scale: Double, context: Context) {
  post {
    if (scale == 0.0) {
      setInitialScale(0)
    } else {
      val feelsLike =
        context.resources.displayMetrics.widthPixels / context.resources.displayMetrics.density

      val percentageOfWidth = feelsLike / context.resources.displayMetrics.widthPixels

      setInitialScale(((1 / percentageOfWidth) * (scale * 100)).toInt())
    }
  }
}
```

Для обычного значения UI Scale `100%` формула фактически превращает scale в плотность экрана:

```text
initialScale = displayMetrics.density * 100
```

На тестовом телефоне с override density `224` это примерно:

```text
1.4 * 100 = 140
```

WebView получает viewport около `720 / 1.4 = 514 CSS px`, то есть срабатывает FreeTube mobile breakpoint. В проверочном APK после фикса это подтверждено логом `viewport=515x1088 ... mobile=true`.

```css
@media only screen and (width <= 680px)
```

### Мой форк

`android/app/src/main/java/io/freetubeapp/freetubeandroid/AndroidBridge.kt`:

```kotlin
fun setScale(scale: Int) {
  activity.runOnUiThread {
    if (scale == 100) {
      if (appliedScale != null) {
        mainWebView.setInitialScale(0)
        appliedScale = null
        mainWebView.reload()
      }
    } else if (appliedScale != scale) {
      mainWebView.setInitialScale(scale)
      appliedScale = scale
      mainWebView.reload()
    }
  }
}
```

При `100%` мой код вызывает `setInitialScale(0)`. Это не означает «100% масштаба интерфейса». Это означает «вернуть WebView к default viewport». На данном устройстве default viewport получается шире `680 CSS px`, поэтому CSS остаётся в desktop-режиме.

Более того, пробный `setInitialScale(150)` в `MainActivity` не мог дать чистый результат: после загрузки renderer вызывает `Android.setScale(100)`, который снова сбрасывает initial scale в `0`.

## Минимальный фикс

Исправлять CSS не нужно. Не нужно копировать чужой `MainActivity`, менять User-Agent или добавлять 36 Android-specific media query.

Нужно перенести только смысл расчёта масштаба из чужого форка в мой `AndroidBridge.setScale`:

1. При `scale == 100` не сбрасывать initial scale в `0`.
2. Рассчитать scale через `displayMetrics.density`.
3. Передать рассчитанное значение в `setInitialScale`.
4. Сохранить существующую защиту от повторного reload.

Минимальная форма логики:

```kotlin
val density = activity.resources.displayMetrics.density
val initialScale = (density * scale).toInt()
if (appliedScale != initialScale) {
    mainWebView.setInitialScale(initialScale)
    appliedScale = initialScale
    mainWebView.reload()
}
```

Для специального значения `scale == 0` можно сохранить отдельный сброс в `setInitialScale(0)`, если импорт/настройки используют zero как reset. Для обычного UI Scale `100` должен использоваться рассчитанный native scale, а не `0`.

Ещё точнее повторяет чужой код вариант:

```kotlin
val width = activity.resources.displayMetrics.widthPixels
val density = activity.resources.displayMetrics.density
val feelsLike = width / density
val initialScale = ((width / (feelsLike / width)) * scale).toInt()
```

Но он избыточен: выражение математически сокращается до `density * scale * 100`, если `scale` передаётся как integer percentage.

## Что изменять не надо

### User-Agent override

Удалять его как способ исправления layout не нужно. Чужой форк использует такой же spoofing. Для встроенного Local API это может быть осознанной частью совместимости. Текущая удалённая подмена не решает UI-проблему, но изменение уже сделано в рабочем дереве.

### `useWideViewPort` и `loadWithOverviewMode`

Эксперимент не изменил screenshot. Эти настройки не являются причиной и добавлять их не нужно.

### CSS breakpoint

Изменение `680px` на `720px` или глобальное Android-условие сломает desktop/browser layout и замаскирует native-проблему. CSS уже содержит правильный mobile breakpoint.

### Edge-to-edge и insets

В чужом форке root layout использует `android:fitsSystemWindows="true"`, а WebView добавляется программно. В моём форке используется edge-to-edge и ручные insets. Это влияет на положение контента относительно системных панелей, но не объясняет переключение `@media width <= 680px`. Это отдельная совместимость, её не нужно смешивать с UI scale fix.

## План проверки после применения

1. Изменить только `AndroidBridge.setScale`.
2. Собрать APK документированным Docker-командой.
3. Установить APK с `adb install -r --user 0`.
4. Запустить cold start и снять screenshot.
5. Проверить, что появились mobile признаки чужого APK: mobile top navigation/side navigation и mobile video grid.
6. Запустить `_scripts/android-smoke-test.sh --serial ZY32KFTHMV --test cold-start`.
7. Проверить изменение UI Scale в настройках: `100%`, затем `110%` и возврат в `100%`.

Фактическая проверка после фикса:

- Docker build: `BUILD SUCCESSFUL`.
- APK установлен на `ZY32KFTHMV`, user `0`.
- WebView log: `viewport=515x1088 dpr=1.4 mobile=true`.
- `cold start` запускается с `Status: ok`.
- Smoke test завершился `FAIL=1`: причина в сетевой ошибке `https://api.invidious.io/instances.json -> TypeError: Failed to fetch`, а не в crash или scale. Такой же сетевой fallback уже наблюдался в logcat предыдущих запусков.

## Итог

Фикс `AndroidBridge.setScale` исправляет native WebView scale и теперь корректно повторяет поведение чужого форка. Проверка подтвердила mobile viewport `515 CSS px`, но внешний вид всё равно отличается: мой APK использует текущую версию renderer `0.25.3`, а установленный чужой APK использует старый renderer `0.25.1.1` с другой mobile-навигацией. Поэтому scale fix не обязан визуально превратить текущий интерфейс в интерфейс старого APK.

Для полного совпадения без копирования старой версии нужно отдельно менять renderer-компоненты `TopNav`/`SideNav` и их Android/mobile условия. Это уже не native fix и не одна строка.

## Дополнительный фикс стартового белого экрана

В моём layout WebView создавался с default white background. При cold start он мог показываться до того, как renderer применит тему. В чужом форке первый кадр дополнительно блокируется `OnPreDrawListener` до готовности данных.

Для минимального решения добавлено:

```kotlin
webView.setBackgroundColor(Color.rgb(16, 16, 16))
```

Проверка на устройстве:

- через `150 ms`: системный Android splash с тёмным фоном;
- через `2 s`: тёмный фон, белого экрана нет;
- через `8 s`: обычный UI FreeTube.

Полная блокировка первого кадра до `dataReady` не добавлялась: текущий native слой не получает этот JS-сигнал, а добавление нового bridge-события будет лишней сложностью для устранения белой вспышки.

## Источники

- [MarmadileManteater/FreeTubeAndroid](https://github.com/MarmadileManteater/FreeTubeAndroid)
- [Foreign MainActivity.kt](https://raw.githubusercontent.com/MarmadileManteater/FreeTubeAndroid/development/android/app/src/main/java/io/freetubeapp/freetube/MainActivity.kt)
- [Foreign FreeTubeWebView.kt](https://raw.githubusercontent.com/MarmadileManteater/FreeTubeAndroid/development/android/app/src/main/java/io/freetubeapp/freetube/webviews/FreeTubeWebView.kt)
- [Foreign WebviewExtensions.kt](https://raw.githubusercontent.com/MarmadileManteater/FreeTubeAndroid/development/android/app/src/main/java/io/freetubeapp/freetube/javascript/WebviewExtensions.kt)
- [Foreign AndroidManifest.xml](https://raw.githubusercontent.com/MarmadileManteater/FreeTubeAndroid/development/android/app/src/main/AndroidManifest.xml)
- Локальный APK-анализ `io.freetubeapp.freetube`, версия `0.25.1.1`
- Локальные screenshots/logcat в `tmp/apk-compare/`
