import { randomUUID } from 'node:crypto'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DeleteCommand, DynamoDBDocumentClient, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'

const tableName = process.env.MEMORIES_TABLE
const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
})
const allowedColors = new Set(['#f4c7cf', '#f8df9b', '#c7dced', '#d8c8eb', '#d0e3c8', 'lavender', 'pink', 'yellow', 'blue', 'green'])

const response = (statusCode, payload) => ({
  statusCode,
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify(payload),
})

function parseBody(event) {
  if (!event.body) return {}
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body
    const body = JSON.parse(raw)
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Body must be a JSON object.')
    return body
  } catch {
    throw Object.assign(new Error('Request body must be valid JSON.'), { statusCode: 400 })
  }
}

function validateText(value) {
  if (typeof value !== 'string' || !value.trim()) throw Object.assign(new Error('Text is required.'), { statusCode: 400 })
  if (value.trim().length > 2000) throw Object.assign(new Error('Text must be 2,000 characters or fewer.'), { statusCode: 400 })
  return value.trim()
}

function validateDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw Object.assign(new Error('Date must use YYYY-MM-DD format.'), { statusCode: 400 })
  }
  const parsed = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw Object.assign(new Error('Date must be a valid calendar date.'), { statusCode: 400 })
  }
  return value
}

function validateColor(value) {
  if (typeof value !== 'string' || !allowedColors.has(value.toLowerCase())) {
    throw Object.assign(new Error('Color is not supported.'), { statusCode: 400 })
  }
  return value.toLowerCase()
}

function verifiedUserId(event) {
  // Trust only claims added by API Gateway's configured JWT authorizer.
  const sub = event.requestContext?.authorizer?.jwt?.claims?.sub
  if (typeof sub !== 'string' || !sub) throw Object.assign(new Error('Unauthorized.'), { statusCode: 401 })
  return `google#${sub}`
}

async function listMemories(userId) {
  const memories = []
  let ExclusiveStartKey
  do {
    const result = await docClient.send(new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'userId = :userId',
      ExpressionAttributeValues: { ':userId': userId },
      ExclusiveStartKey,
    }))
    memories.push(...(result.Items || []))
    ExclusiveStartKey = result.LastEvaluatedKey
  } while (ExclusiveStartKey)
  memories.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return response(200, { memories, count: memories.length })
}

async function createMemory(userId, body) {
  const now = new Date().toISOString()
  const memory = {
    userId,
    memoryId: randomUUID(),
    text: validateText(body.text),
    date: validateDate(body.date),
    color: validateColor(body.color),
    createdAt: now,
    updatedAt: now,
  }
  await docClient.send(new PutCommand({
    TableName: tableName,
    Item: memory,
    ConditionExpression: 'attribute_not_exists(userId) AND attribute_not_exists(memoryId)',
  }))
  return response(201, { message: 'Memory created successfully', memory })
}

async function updateMemory(userId, memoryId, body) {
  const fields = []
  const names = {}
  const values = { ':updatedAt': new Date().toISOString() }
  if (Object.hasOwn(body, 'text')) { names['#text'] = 'text'; values[':text'] = validateText(body.text); fields.push('#text = :text') }
  if (Object.hasOwn(body, 'date')) { names['#date'] = 'date'; values[':date'] = validateDate(body.date); fields.push('#date = :date') }
  if (Object.hasOwn(body, 'color')) { names['#color'] = 'color'; values[':color'] = validateColor(body.color); fields.push('#color = :color') }
  if (!fields.length) throw Object.assign(new Error('Provide text, date, or color to update.'), { statusCode: 400 })
  names['#updatedAt'] = 'updatedAt'
  fields.push('#updatedAt = :updatedAt')
  try {
    const result = await docClient.send(new UpdateCommand({
      TableName: tableName,
      Key: { userId, memoryId },
      UpdateExpression: `SET ${fields.join(', ')}`,
      ConditionExpression: 'attribute_exists(userId) AND attribute_exists(memoryId)',
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ReturnValues: 'ALL_NEW',
    }))
    return response(200, { message: 'Memory updated successfully', memory: result.Attributes })
  } catch (error) {
    if (error.name === 'ConditionalCheckFailedException') return response(404, { message: 'Memory not found.' })
    throw error
  }
}

async function deleteMemory(userId, memoryId) {
  try {
    await docClient.send(new DeleteCommand({
      TableName: tableName,
      Key: { userId, memoryId },
      ConditionExpression: 'attribute_exists(userId) AND attribute_exists(memoryId)',
    }))
    return response(200, { message: 'Memory deleted successfully', memoryId })
  } catch (error) {
    if (error.name === 'ConditionalCheckFailedException') return response(404, { message: 'Memory not found.' })
    throw error
  }
}

export const handler = async (event) => {
  if (!tableName) {
    console.error('Missing MEMORIES_TABLE environment variable.')
    return response(500, { message: 'Server configuration error.' })
  }
  try {
    const userId = verifiedUserId(event)
    const method = event.requestContext?.http?.method || event.httpMethod
    const path = event.rawPath || event.path || ''
    if (method === 'GET' && path.endsWith('/memories')) return await listMemories(userId)
    if (method === 'POST' && path.endsWith('/memories')) return await createMemory(userId, parseBody(event))
    const id = event.pathParameters?.id
    if (!id) return response(404, { message: 'Route not found.' })
    if (method === 'PUT') return await updateMemory(userId, id, parseBody(event))
    if (method === 'DELETE') return await deleteMemory(userId, id)
    return response(404, { message: 'Route not found.' })
  } catch (error) {
    if (error.statusCode) return response(error.statusCode, { message: error.message })
    if (error.name === 'ConditionalCheckFailedException') return response(409, { message: 'Memory already exists.' })
    console.error('Memory API request failed.', { name: error.name, message: error.message })
    return response(500, { message: 'Internal server error.' })
  }
}
