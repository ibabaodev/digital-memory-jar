# Digital Memory Jar API

Lambda handler for the four authenticated API Gateway HTTP API routes. It expects payload format **2.0** and a Google JWT authorizer attached to each route. The function trusts only `event.requestContext.authorizer.jwt.claims.sub`; it never uses a client-provided `userId`.

## Deploy from PowerShell

Run from the repository root. Use Node.js 22 and npm.

```powershell
Set-Location backend
npm install
npm.cmd ci --omit=dev
Compress-Archive -Path index.mjs, package.json, node_modules -DestinationPath lambda.zip -Force
```

Upload `backend/lambda.zip` to a Lambda function configured with:

- Runtime: Node.js 22.x
- Handler: `index.handler`
- Environment variable: `MEMORIES_TABLE=DigitalMemoryJar`
- Timeout: 10 seconds or more
- Execution role: CloudWatch Logs permissions and the table-scoped policy below

When updating an existing ZIP, remove the old archive first or use a clean `backend/deploy` staging folder to avoid stale dependency files.

## DynamoDB execution role policy

Replace the Region and account ID as needed. The table must use `userId` (String) as partition key and `memoryId` (String) as sort key.

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["dynamodb:Query", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"],
    "Resource": "arn:aws:dynamodb:ap-southeast-1:YOUR_ACCOUNT_ID:table/DigitalMemoryJar"
  }]
}
```

## API Gateway routes

Create Lambda proxy integrations with payload format **2.0** for each route and attach the Google JWT authorizer to all four:

| Method | Route | Success |
| --- | --- | --- |
| GET | `/memories` | `200 { memories, count }` |
| POST | `/memories` | `201 { message, memory }` |
| PUT | `/memories/{id}` | `200 { message, memory }` |
| DELETE | `/memories/{id}` | `200 { message, memoryId }` |

The handler expects the authorized Google token to provide a `sub` claim. Configure API Gateway's JWT issuer as `https://accounts.google.com` and audience as the web OAuth client ID. The `userId` key is generated server-side as `google#<sub>`.

The handler returns JSON errors with appropriate `400`, `401`, `404`, `409`, or `500` status codes. Configure HTTP API CORS in API Gateway for your exact frontend origin, methods `GET, POST, PUT, DELETE, OPTIONS`, and headers `authorization, content-type`. API Gateway handles preflight when CORS is enabled; do not attach JWT authorization to a separate OPTIONS route.

## Deploy using AWS CLI (alternative)

After creating the function, role, table, and API Gateway routes, package the dependencies as above and upload:

```powershell
aws lambda update-function-code --function-name DigitalMemoryJarAPI --zip-file fileb://lambda.zip
```

Run that command from the `backend` directory. The Lambda execution role, not the caller's browser, receives access to DynamoDB.
