import express, { type Express } from 'express'

export function buildApp(): Express {
  const app = express()
  app.disable('x-powered-by')
  app.use(express.json({ limit: '256kb' }))

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' })
  })

  return app
}
