FROM nginx:1.31-alpine

# openssl: self-signed cert  |  inotify-tools: config watcher  |  bash: scripts
RUN apk add --no-cache openssl inotify-tools bash

COPY nginx.conf /etc/nginx/nginx.conf
COPY snippets/ /etc/nginx/snippets/
COPY error.html /etc/nginx/error.html
COPY entrypoint.sh watcher.sh reload.sh /usr/local/bin/

# Strip CR if the scripts were authored on Windows, then make executable.
# Stash a pristine copy of the full config outside /etc/nginx so the entrypoint can seed a
# bind-mounted (initially empty) /etc/nginx on first boot.
RUN sed -i 's/\r$//' /usr/local/bin/entrypoint.sh /usr/local/bin/watcher.sh /usr/local/bin/reload.sh \
 && chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/watcher.sh /usr/local/bin/reload.sh \
 && mkdir -p /etc/nginx/sites /etc/nginx/certs /usr/local/share \
 && cp -a /etc/nginx /usr/local/share/nginx-defaults

EXPOSE 80 443
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
