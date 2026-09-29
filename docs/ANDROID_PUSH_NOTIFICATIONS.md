# Android Push Notifications

## How it works

* Users enable notifications per channel.
* App stores enabled channel IDs and last seen video IDs in Android `SharedPreferences`. Native worker does not depend on open WebView.
* Android `WorkManager` fetches each channel RSS feed from YouTube and posts local notification for each newly detected video.
* Sync schedules immediate check when subscriptions change and maintains unique periodic work. Periodic interval has Android minimum of 15 minutes. This is not delivery deadline.
* First successful check sets baseline without notifying about existing videos. Later checks notify about new items. If stored video ID is no longer in feed, only newest item is reported to avoid burst of old notifications.
* Tapping notification opens video through app deep link flow.

## Closed app behavior and limits

Worker can run without open Activity. It is scheduled work, not persistent process. Android controls execution time. Doze, battery restrictions, OEM policies, connectivity, RSS availability, and force stop can delay or prevent checks. Notifications are best effort. Delivery and timing are not guaranteed. Force stop is not bypassed.

Physical device smoke test verified periodic worker run and local notification while Activity was not open. This confirms background execution can work on that device. It does not establish reliable delivery across devices or conditions.

## Push distinction

Implementation polls RSS from device. It does not use FCM, UnifiedPush, or server side delivery service. Remote push would require backend to track new videos and send events through push transport such as UnifiedPush. This is outside current implementation.
