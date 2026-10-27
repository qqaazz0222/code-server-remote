# Production image: the official code-server release with this fork's server
# (out/) and pages layered on top. Dependencies match the base release, so the
# prebuilt VS Code and node_modules in the base image are reused.
#
# Build after `npm run build`, sending only what's needed as context:
#   tar -c ci/remote/Dockerfile package.json out src/browser/pages src/images |
#     docker build -t code-server-remote --build-arg COMMIT=$(git rev-parse HEAD) -f ci/remote/Dockerfile -
FROM codercom/code-server:4.141.0
COPY out /usr/lib/code-server/out
COPY src/browser/pages /usr/lib/code-server/src/browser/pages
COPY src/images /usr/lib/code-server/src/images
# The base package.json still reports the upstream release; stamp this fork's
# version and commit into it so --version and the UI show what is running.
ARG COMMIT=development
COPY package.json /tmp/fork-package.json
USER root
RUN cd /usr/lib/code-server && ./lib/node -e ' \
  const fs = require("fs"); \
  const pkg = JSON.parse(fs.readFileSync("package.json")); \
  pkg.version = JSON.parse(fs.readFileSync("/tmp/fork-package.json")).version; \
  pkg.commit = process.argv[1]; \
  fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n"); \
  ' "$COMMIT" && rm /tmp/fork-package.json
USER 1000
