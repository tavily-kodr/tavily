# Tavily 

## Search API

### Docker Setup

The Search API uses SearXNG running through Docker.

From the project root, go to the `infra` folder:

```bash
cd infrastructure

docker compose up -d

http://localhost:8080

```

Start the API using:

```bash
cd ../packages/app

pnpm run dev

```

The Search API runs on:
```bash
http://localhost:3000
```

### Endpoint
```bash
GET /search?q=react
```

## Example:
```bash
curl "http://localhost:3000/search?q=react"
```

### Response
```bash
{
  "statusCode": 200,
  "message": "Search successful",
  "data": {
    "query": "react",
    "urls": [
      "https://react.dev/",
      "https://github.com/react/react"
    ]
  },
  "success": true
}
```

