# Digital Memory Jar

A private web application for collecting little moments and rediscovering them by surprise. Users sign in with Google, write memories, and store them as colorful notes in a virtual jar. Shaking the jar reveals a randomly selected memory. Users can also view, edit, and delete their saved memories.

The intended cloud-backed application uses a **React + TypeScript + Vite** frontend, **Google sign-in**, an **API Gateway HTTP API** with a Google JWT authorizer, **AWS Lambda**, and **Amazon DynamoDB**. Memories are scoped to each signed-in Google account.

> **Setup status:** This README documents the architecture, API routes, DynamoDB schema, CORS settings, and Lambda implementation discussed so far. The API route layout was shown in an AWS Console screenshot. The Lambda source code and setup instructions were provided, but deployment, JWT authorizer attachment, DynamoDB permissions, successful API requests, and production hosting have **not** been independently confirmed. Verify the checklist at the end before describing the backend as live.

## Features (MVP)

- Sign in with Google to access private memories.
- Add a memory with text and a date; assign a paper-slip color.
- See colorful paper slips in a virtual glass jar.
- Shake the jar to reveal a random saved memory.
- View existing memories.
- Edit a memory's text, date, or color.
- Delete a memory after confirmation.
- Load and save memories using authenticated API requests.

The shake animation and random selection happen in the **frontend**, not Lambda. There is no `/shake` API route.

## Run locally

Requirements: **Node.js 22.12+** (or a version compatible with your installed Vite release), npm, a Google OAuth web client, and a deployed API Gateway endpoint.

From the existing frontend project directory:

```powershell
npm install
Copy-Item .env.example .env.local
npm run dev
```

Set both values in `.env.local`:

```dotenv
VITE_GOOGLE_CLIENT_ID=your-web-client-id.apps.googleusercontent.com
VITE_API_BASE_URL=https://your-api-id.execute-api.ap-southeast-1.amazonaws.com
```

The app uses the Google Identity Services sign-in button to obtain a Google ID token and sends it as a bearer token to API Gateway. The token is held in memory, so refreshing the page requires signing in again. The API remains the only memory store; no memories or tokens are persisted in browser storage. Reliable sign-in persistence across refresh requires adding a server-managed application session (for example, a secure, HttpOnly cookie endpoint) to the backend. Restart Vite whenever environment variables change. Without a valid API endpoint and OAuth client, sign-in or memory requests will show configuration errors.

## Google OAuth client

In [Google Cloud Console → Google Auth Platform → Clients](https://console.cloud.google.com/auth/clients), create or reuse an OAuth client of type **Web application**.

1. Configure app branding and audience / OAuth consent settings as required.
2. Add `http://localhost:5173` under **Authorized JavaScript origins**.
3. Add the **exact origin** of the hosted frontend later, such as `https://your-domain.example` (without a trailing path).
4. If the consent screen is in Testing mode and requires test users, add the Google account used for testing.
5. Copy the web **Client ID** ending in `.apps.googleusercontent.com` into `VITE_GOOGLE_CLIENT_ID`.

Do **not** put a Google client secret in Vite environment variables or frontend source code. The browser uses the Client ID and sends the Google **ID token** in API requests. Do not substitute an OAuth **access token** for this API authentication design.

For direct Google Identity Services login, the ID token normally contains:

- Issuer (`iss`): `https://accounts.google.com` (Google may also use `accounts.google.com`).
- Audience (`aud`): the Google OAuth web Client ID.
- Subject (`sub`): the stable Google account identifier.
- Expiration (`exp`): token expiration time.

The application uses `sub`, **not the user's email address**, to scope stored data.

References: [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect), [Google ID token verification](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token).

## AWS Console setup (manual; no CDK required)

Use the same AWS Region for Lambda and DynamoDB. The examples below assume **`ap-southeast-1` (Singapore)**.

### 1. Create the DynamoDB table

Open **AWS Console → DynamoDB → Tables → Create table** and enter:

| Setting | Value |
| --- | --- |
| Table name | `DigitalMemoryJar` |
| Partition key | `userId` — String |
| Sort key | `memoryId` — String |
| Capacity mode | On-demand |
| Secondary indexes | None for MVP |
| Streams | Disabled for MVP |
| Encryption | Default AWS-owned key |

DynamoDB does not require you to predefine the remaining attributes.

#### Item schema

| Attribute | Type | Example |
| --- | --- | --- |
| `userId` | String, partition key | `google#123456789` |
| `memoryId` | String, sort key | `12b3f3de-...` |
| `text` | String | `Had dinner with my childhood friends.` |
| `date` | String (`YYYY-MM-DD`) | `2026-11-20` |
| `color` | String | `lavender` |
| `createdAt` | String (ISO 8601 UTC) | `2026-11-20T14:00:00.000Z` |
| `updatedAt` | String (ISO 8601 UTC) | `2026-11-20T14:00:00.000Z` |

Example DynamoDB item:

```json
{
  "userId": "google#123456789",
  "memoryId": "4a22335f-416f-40ca-a68a-5d33ea93b8c9",
  "text": "Had dinner with my childhood friends.",
  "date": "2026-11-20",
  "color": "lavender",
  "createdAt": "2026-11-20T14:00:00.000Z",
  "updatedAt": "2026-11-20T14:00:00.000Z"
}
```

Every user's records share that user's unique `userId` partition key. Listing memories uses DynamoDB **Query**, not **Scan**.

### 2. Create the Lambda function

In **AWS Console → Lambda → Create function → Author from scratch**:

| Setting | Value |
| --- | --- |
| Function name | `DigitalMemoryJarAPI` |
| Runtime | Node.js 22.x |
| Handler | `index.handler` |
| Architecture | `x86_64` (default is fine) |
| Timeout | 10 seconds to start |
| Memory | 128 MB to start |

In **Configuration → Environment variables**, set:

```text
MEMORIES_TABLE=DigitalMemoryJar
```

The deployable Lambda handler is in [`backend/index.mjs`](backend/index.mjs); deployment and packaging instructions are in [`backend/README.md`](backend/README.md). It is an ES module (`index.handler`), uses the AWS SDK for JavaScript v3, and handles API Gateway HTTP API payload format 2.0 requests.

The handler performs:

- `GET /memories` → DynamoDB `Query` for the authenticated `userId`, with `LastEvaluatedKey` handling; sorts retrieved results by `createdAt` descending.
- `POST /memories` → validates body, generates a UUID, writes a new item with `PutCommand` and a condition preventing duplicate keys.
- `PUT /memories/{id}` → validates provided changes and uses `UpdateCommand` with a condition requiring an existing item.
- `DELETE /memories/{id}` → uses `DeleteCommand` with a condition requiring an existing item.

Validation includes nonempty text (up to 2,000 characters), an actual `YYYY-MM-DD` calendar date, and a permitted color string. The frontend should use an actual date format matching the backend.

**Authentication assumption:** The handler expects an **HTTP API Lambda proxy integration using payload format 2.0** and extracts the verified account ID from:

```js
const googleSub = event.requestContext?.authorizer?.jwt?.claims?.sub;
const userId = `google#${googleSub}`;
```

If `sub` is missing, the example implementation returns `401 Unauthorized`. This is **not** equivalent to independently verifying a user-supplied JWT in Lambda: the function must be reachable through the protected API Gateway integration, and routes must use the JWT authorizer. Avoid exposing an unprotected Lambda Function URL or alternate public route to the same handler.

### 3. Give Lambda least-privilege DynamoDB access

In **Lambda → DigitalMemoryJarAPI → Configuration → Permissions**, open its execution role in IAM.

Attach the basic CloudWatch Logs execution permissions if not already present. Add an **inline IAM policy** for the single DynamoDB table (replace `YOUR_ACCOUNT_ID`):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "dynamodb:Query",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:DeleteItem"
      ],
      "Resource": "arn:aws:dynamodb:ap-southeast-1:YOUR_ACCOUNT_ID:table/DigitalMemoryJar"
    }
  ]
}
```

The supplied handler doesn't require `Scan`, `GetItem`, or `TransactWriteItems`. Add permissions later only if the implementation changes.

### 4. Create the HTTP API and JWT authorizer

In **AWS Console → API Gateway → HTTP APIs**, use the `DigitalMemoryJar` API and add a **JWT authorizer**:

| Setting | Value |
| --- | --- |
| Authorizer name | `GoogleJWTAuthorizer` |
| Type | JWT |
| Identity source | `$request.header.Authorization` |
| Issuer URL | `https://accounts.google.com` |
| Audience | Your **Google OAuth web Client ID** |
| Authorization scopes | Leave empty for the Google ID-token setup |

For direct Google OAuth ID tokens, this authorizer checks the issuer, signature, audience, time-based claims, and other supported JWT validation rules before sending the request to Lambda. Reference: [AWS HTTP API JWT authorizers](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-jwt-authorizer.html).

> If you used **Firebase Authentication** instead of direct Google Identity Services, these exact JWT issuer and audience values are **not** correct for Firebase-issued ID tokens. Configure the authorizer for the actual token issuer and audience.

### 5. Add routes, authorizer, and Lambda integration

The API Gateway Routes screenshot in this conversation showed these four routes:

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/memories` | List current user's memories |
| `POST` | `/memories` | Add a memory |
| `PUT` | `/memories/{id}` | Edit a memory |
| `DELETE` | `/memories/{id}` | Delete a memory |

For **every route**:

1. Set the integration target to `DigitalMemoryJarAPI`.
2. Use **Lambda proxy payload format 2.0**.
3. Attach `GoogleJWTAuthorizer`.
4. Save changes and confirm API Gateway has permission to invoke Lambda.

Use the `$default` stage with auto-deploy enabled, or manually deploy the stage after changing integrations, routes, or authorization. Copy the **Invoke URL** from API Gateway; do not append `/memories` to the base URL in `.env.local`.

### 6. Configure CORS

In **API Gateway → DigitalMemoryJar → CORS**, use:

| Setting | Value |
| --- | --- |
| Access-Control-Allow-Origin | `http://localhost:5173` |
| Access-Control-Allow-Methods | `GET`, `POST`, `PUT`, `DELETE`, `OPTIONS` |
| Access-Control-Allow-Headers | `Content-Type`, `Authorization` |
| Access-Control-Expose-Headers | Leave empty |
| Access-Control-Max-Age | `300` (optional) |
| Access-Control-Allow-Credentials | `NO` for bearer-token requests without cross-origin cookies |

The shared AWS Console screenshot showed **`http://localhost:5173` already entered** as an allowed origin; the other values were recommended, not confirmed saved.

Add the exact production frontend origin as another allowed origin when deploying. With CORS configured on an **API Gateway HTTP API**, API Gateway normally answers the browser's preflight `OPTIONS` requests automatically; you do not need a separate memory `OPTIONS` Lambda route.

CORS is **not authentication**. Keep JWT authorization enabled on all four functional API routes.

## Frontend authentication and API requests

The app loads Google's Identity Services client and renders its sign-in button using `VITE_GOOGLE_CLIENT_ID`. The success callback supplies the Google **ID token** in `credential`.

Send the ID token as a bearer token for **every** API operation:

```ts
const apiBaseUrl = import.meta.env.VITE_API_BASE_URL;

async function listMemories(googleIdToken: string) {
  const result = await fetch(`${apiBaseUrl}/memories`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${googleIdToken}`,
    },
  });

  if (!result.ok) {
    throw new Error(`Request failed: ${result.status}`);
  }

  return result.json();
}
```

Avoid saving Google ID tokens in `localStorage`. Google ID tokens expire; implement a reauthentication or application session flow rather than assuming a token will remain valid indefinitely.

### API request and response formats

**GET `/memories`**

Success: `200 OK`

```json
{
  "memories": [],
  "count": 0
}
```

**POST `/memories`**

Body:

```json
{
  "text": "Had dinner with my childhood friends.",
  "date": "2026-11-20",
  "color": "lavender"
}
```

Success: `201 Created` with `{ "message": "Memory created successfully", "memory": { ... } }`.

**PUT `/memories/{id}`**

Body (only fields to update):

```json
{
  "text": "Dinner and a movie with my friends.",
  "date": "2026-11-20"
}
```

Success: `200 OK` with `{ "message": "Memory updated successfully", "memory": { ... } }`.

**DELETE `/memories/{id}`**

Success: `200 OK` with `{ "message": "Memory deleted successfully", "memoryId": "..." }`.

The frontend uses **`memoryId** for the database key and sends it in PUT and DELETE paths. The `userId` in a response is not needed by the UI and must never be accepted from a client as the authorization identity.

### Error responses

| Status | Typical meaning |
| --- | --- |
| `400` | Invalid JSON, empty text, invalid date/color, or no update fields |
| `401` | Missing, expired, or invalid Google ID token |
| `404` | Memory not found, or unmatched route |
| `409` | Duplicate key condition on creation (rare with UUIDs) |
| `500` | Internal error or server configuration issue |

## Testing

Test through the **API Gateway Invoke URL**, not just a Lambda Console test event; the Lambda Console will not automatically supply `requestContext.authorizer.jwt.claims.sub`.

Use this checklist:

1. Call `GET /memories` **without** an `Authorization` header → expect `401` at API Gateway.
2. Call with an invalid or expired Google ID token → expect `401`.
3. Sign in with the configured Google client and call `GET /memories` → expect `200` with an initially empty list.
4. Call `POST /memories` with valid text and date → expect `201` and a `memoryId`.
5. Call `GET /memories` again → the new memory appears.
6. Call `PUT /memories/{id}` → expect `200` and updated fields.
7. Call `DELETE /memories/{id}` → expect `200`.
8. Call `GET /memories` again → the deleted memory no longer appears.
9. Sign in as a **different Google account** → it must not see or modify the first account's memories.
10. Test from both local and production frontend origins after configuring CORS.

To test from PowerShell after obtaining a valid Google **ID token**:

```powershell
$apiUrl = 'https://your-api-id.execute-api.ap-southeast-1.amazonaws.com'
$idToken = 'PASTE_SHORT_LIVED_GOOGLE_ID_TOKEN_HERE'
$headers = @{ Authorization = "Bearer $idToken" }

Invoke-RestMethod -Uri "$apiUrl/memories" -Method Get -Headers $headers
```

Do not commit, publish, or screenshot real ID tokens.

## Frontend hosting

Vercel or AWS Amplify Hosting can host a Vite frontend. For a standard Vite project, the build command is `npm run build` and the output directory is `dist`.

Configure the host's build-time environment variables:

```dotenv
VITE_GOOGLE_CLIENT_ID=your-web-client-id.apps.googleusercontent.com
VITE_API_BASE_URL=https://your-api-id.execute-api.ap-southeast-1.amazonaws.com
```

After deployment:

- Add the **exact hosted origin** to the Google OAuth client's authorized JavaScript origins.
- Add that same origin to API Gateway CORS.
- Redeploy the frontend so Vite embeds the correct environment settings.
- Verify JWT authentication and all four API routes from the actual domain.

No production domain for Digital Memory Jar has been confirmed in this conversation.

## Project structure (suggested)

The existing React Vite project can remain at the repository root. A separate backend repository is not required:

```text
DigitalMemoryJar/
├── public/
├── src/
│   ├── components/
│   │   ├── MemoryJar.tsx
│   │   ├── MemoryForm.tsx
│   │   ├── MemoryList.tsx
│   │   └── MemoryReveal.tsx
│   ├── services/
│   │   └── memoriesApi.ts
│   ├── types/
│   │   └── memory.ts
│   ├── App.tsx
│   ├── main.tsx
│   └── index.css
├── backend/                 # Optional: keep a source copy of Lambda code
│   └── index.mjs
├── .env.example
├── package.json
├── vite.config.ts
└── README.md
```

This structure is illustrative; the current frontend uses Google Identity Services directly and keeps its API operations in `src/App.tsx`.

## Scripts

For a standard React + TypeScript Vite project:

- `npm run dev` — run the local development server.
- `npm run build` — type-check and build the frontend (depending on generated package scripts).
- `npm run lint` — run the lint command defined in `package.json`.
- `npm run preview` — preview the production frontend locally.

Check `package.json` for the exact scripts in your project.

## Security and cost notes

- Authenticate all four routes with the Google JWT authorizer; never use an unverified client-supplied `userId`.
- Ensure a user only accesses items keyed by `google#${verifiedSub}`.
- Do not expose Google client secrets or AWS credentials in the frontend.
- Use least-privilege IAM permissions scoped to the single DynamoDB table.
- Save memories with server-generated `memoryId`, `createdAt`, and `updatedAt`.
- Use DynamoDB **on-demand** capacity for a small, variable-traffic app. DynamoDB, Lambda, API Gateway, logs, and optional backup features can incur charges.
- Because personal memories are important, consider recovery and backup options before a production launch.
- The current `GET /memories` example queries all pages and returns all items. Add pagination if the number of memories per user grows enough to make requests large or slow.

## Verification checklist

- [x] Chosen app concept: add memories, shake to reveal, view/edit/delete.
- [x] Chosen database key design: `userId` + `memoryId`.
- [x] API Gateway route layout shown: GET/POST `/memories`, PUT/DELETE `/memories/{id}`.
- [x] Lambda handler implementation supplied in conversation for the four routes.
- [x] Local origin `http://localhost:5173` shown in the API Gateway CORS console.
- [ ] Confirm the DynamoDB table is **Active** and uses the expected keys.
- [ ] Confirm the Lambda source is deployed and `MEMORIES_TABLE` is set.
- [ ] Confirm Lambda execution-role IAM permissions are attached.
- [ ] Confirm all four routes integrate with the correct Lambda at payload format 2.0.
- [ ] Confirm `GoogleJWTAuthorizer` is created and attached to all four routes.
- [ ] Confirm the remaining CORS settings are saved and the API stage is deployed.
- [ ] Confirm React Google sign-in supplies a Google **ID token**.
- [ ] Verify complete CRUD behavior and cross-account isolation through API Gateway.
- [ ] Configure and verify the production frontend origin if/when deployed.

## Official references

- [AWS API Gateway HTTP API JWT authorizers](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-jwt-authorizer.html)
- [AWS API Gateway HTTP API CORS](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-cors.html)
- [DynamoDB key schema](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/HowItWorks.CoreComponents.html)
- [Google ID token verification](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token)
- [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect)
