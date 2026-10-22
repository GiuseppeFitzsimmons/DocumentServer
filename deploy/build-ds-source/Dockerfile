# Full ONLYOFFICE Docs build from source, inside Ubuntu 24.04.
#
# WHY a container: the host is Ubuntu 26.04 but build_tools' automate.py runs
# apt-get against a fixed 24.04 package list. Building inside 24.04 isolates the
# OS mismatch; the output is still a native-Linux documentserver tree.
#
# This image is just the BUILD ENVIRONMENT (24.04 + python3 + git + sudo). The
# actual build runs via run.sh, which invokes automate.py with the toolchain and
# source checkout kept in a mounted volume so the (large, slow) Qt/sysroot/deps
# downloads survive across runs and are not baked into the image.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# automate.py itself shells out to sudo + apt-get for the rest of the deps, so we
# only need the bootstrap set here.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        sudo git python3 python3-pip ca-certificates curl wget \
        xz-utils bzip2 tar build-essential \
        software-properties-common && \
    add-apt-repository universe && \
    add-apt-repository multiverse && \
    apt-get update

# Bake the build dependencies into the image. deps.py would install these at
# runtime, but we run with --rm so a runtime install would be discarded. Baking
# them makes the environment reproducible and lets us skip deps.py (we touch its
# packages_complete sentinel in run.sh). Mirrors build_tools/tools/linux/deps.py
# with 24.04-valid package names.
RUN apt-get install -y --no-install-recommends \
        autoconf cmake perl subversion gzip libtool p7zip-full \
        glib-2.0-dev libglu1-mesa-dev libgtk-3-dev libpulse-dev \
        libasound2-dev libatspi2.0-dev libcups2-dev libdbus-1-dev \
        libicu-dev libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev \
        libx11-xcb-dev libxi-dev libxrender-dev libxss1 \
        libxkbcommon-dev libxkbcommon-x11-dev libnotify-dev \
        openjdk-11-jdk unzip && \
    apt-get install -y --no-install-recommends 'libxcb*-dev' || true

# Node 18 (24.04 universe) + global build tooling deps.py pulls.
RUN apt-get install -y --no-install-recommends nodejs npm && \
    npm install -g grunt-cli && \
    npm install -g @yao-pkg/pkg@6.11.0

# Official prebuilt ninja. The apt ninja (24.04) links against the system
# libstdc++; when V8's build runs it under the ubuntu16 sysroot library path,
# it fails on missing GLIBCXX symbols. The official release binary has no such
# runtime dependency. Placed in /usr/local/bin (ahead of /usr/bin on PATH).
RUN wget -q https://github.com/ninja-build/ninja/releases/download/v1.11.1/ninja-linux.zip -O /tmp/ninja.zip && \
    unzip -o /tmp/ninja.zip -d /usr/local/bin && \
    chmod +x /usr/local/bin/ninja && \
    rm /tmp/ninja.zip && \
    /usr/local/bin/ninja --version

# automate.py calls `sudo` with no password; make that work non-interactively.
RUN echo "root ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers

WORKDIR /build
ENTRYPOINT ["/bin/bash"]
