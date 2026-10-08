# Production SearXNG image: settings are baked in so the container does not
# depend on a host bind mount. Keep the tag pinned; never use :latest.
FROM searxng/searxng:2026.10.7-6671d89be

COPY searxng/settings.yml /etc/searxng/settings.yml
