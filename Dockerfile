FROM node:26-bookworm

ARG ANDROID_CMDLINE_TOOLS=13114758

ENV ANDROID_HOME=/opt/android-sdk \
    ANDROID_SDK_ROOT=/opt/android-sdk \
    PATH=/opt/android-sdk/cmdline-tools/latest/bin:/opt/android-sdk/platform-tools:/opt/android-sdk/emulator:$PATH

RUN apt-get update \
    && apt-get install --no-install-recommends --yes \
       ca-certificates \
       curl \
       git \
       openjdk-17-jdk-headless \
       unzip \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p "$ANDROID_HOME/cmdline-tools" \
    && curl --fail --silent --show-error --location \
       "https://dl.google.com/android/repository/commandlinetools-linux-${ANDROID_CMDLINE_TOOLS}_latest.zip" \
       --output /tmp/android-commandline-tools.zip \
    && unzip -q /tmp/android-commandline-tools.zip -d "$ANDROID_HOME/cmdline-tools" \
    && mv "$ANDROID_HOME/cmdline-tools/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest" \
    && rm /tmp/android-commandline-tools.zip \
    && yes | sdkmanager --licenses >/dev/null || true \
    && sdkmanager "platform-tools" "platforms;android-35" "build-tools;35.0.0" \
    && npm install --global pnpm@11.23.0 \
    && git config --global --add safe.directory /workspace \
    && rm -rf /root/.npm

WORKDIR /workspace

CMD ["bash"]
