FROM node:22-bookworm

# Install system dependencies
RUN apt-get update && apt-get install -y \
  git \
  curl \
  jq \
  && rm -rf /var/lib/apt/lists/*

# Install system dependencies for Beads
RUN apt-get update && apt-get install -y \
  dpkg-dev \
  libicu72 \
  && rm -rf /var/lib/apt/lists/* \
  && ARCH_DIR=$(dpkg-architecture -qDEB_HOST_MULTIARCH) \
  && for lib in /usr/lib/$ARCH_DIR/libicu*.so.72; do \
       ln -s "$lib" "${lib%.72}.74"; \
     done

RUN curl -fsSL https://raw.githubusercontent.com/steveyegge/beads/main/scripts/install.sh | bash

RUN corepack enable

# Rename the base image's "node" user (UID 1000) to "agent".
# This keeps UID 1000 so that --userns=keep-id (Podman) and
# --user 1000:1000 (Docker) map to the correct home directory owner.
RUN usermod -d /home/agent -m -l agent node
USER agent

# Install Claude Code CLI
RUN curl -fsSL https://claude.ai/install.sh | bash

# Add Claude to PATH
ENV PATH="/home/agent/.local/bin:$PATH"

# Sandcastle's docker provider runs the container as the host UID (e.g. 501 on
# macOS), not the in-image agent (UID 1000). Open up /home/agent so any UID
# can write to it (.gitconfig, npm cache, etc.).
RUN chmod -R a+rwX /home/agent

WORKDIR /home/agent

# In worktree sandbox mode, Sandcastle bind-mounts the git worktree at /home/agent/workspace
# and overrides the working directory to /home/agent/workspace at container start.
# Structure your Dockerfile so that /home/agent/workspace can serve as the project root.
ENTRYPOINT ["sleep", "infinity"]
