import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { pool } from '../db/pool.js';
export const usersRouter = Router();
// All user routes require authentication
usersRouter.use(requireAuth);
// GET /api/users/search?q=<query> — Search users by email or display name
usersRouter.get('/search', async (req, res) => {
    try {
        const q = req.query.q;
        const userId = req.session.userId;
        if (!q || q.trim().length < 2) {
            res.json([]);
            return;
        }
        const searchTerm = `%${q.trim()}%`;
        const { rows } = await pool.query(`SELECT id, email, display_name AS name
       FROM users
       WHERE id != $1
         AND (email ILIKE $2 OR display_name ILIKE $2)
       LIMIT 10`, [userId, searchTerm]);
        res.json(rows);
    }
    catch (err) {
        console.error('User search error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});
//# sourceMappingURL=routes.js.map