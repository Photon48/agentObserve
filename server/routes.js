import express from 'express';

export function createRouter(getSessions) {
  const router = express.Router();

  // Summaries sorted newest-first, no turns
  router.get('/sessions', (req, res) => {
    const summaries = getSessions()
      .map(({ id, framework, startTime, endTime, turnCount, totalCost, totalInputTokens, totalOutputTokens }) => ({
        id,
        framework,
        startTime,
        endTime,
        turnCount,
        totalCost,
        totalInputTokens,
        totalOutputTokens,
      }))
      .sort((a, b) => new Date(b.startTime) - new Date(a.startTime));
    res.json(summaries);
  });

  // Full session with turns and steps
  router.get('/sessions/:id', (req, res) => {
    const session = getSessions().find((s) => s.id === req.params.id);
    if (!session) return res.status(404).json({ error: 'Not found' });
    res.json(session);
  });

  return router;
}
