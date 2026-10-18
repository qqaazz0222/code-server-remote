# Production image: the official code-server release with this fork's server
# (out/) and pages layered on top. Dependencies match the base release, so the
# prebuilt VS Code and node_modules in the base image are reused.
#
# Build after `npm run build`, sending only what's needed as context:
#   tar -c ci/remote/Dockerfile out src/browser/pages src/images |
#     docker build -t code-server-remote -f ci/remote/Dockerfile -
FROM codercom/code-server:4.141.0
COPY out /usr/lib/code-server/out
COPY src/browser/pages /usr/lib/code-server/src/browser/pages
COPY src/images /usr/lib/code-server/src/images
