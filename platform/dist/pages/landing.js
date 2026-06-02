import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { listFolder, getRecentFiles } from '../storage/metadata.js';
import { pool } from '../db/pool.js';
export const landingRouter = Router();
landingRouter.get('/', requireAuth, async (req, res, next) => {
    try {
        const userId = req.session.userId;
        const [folderContents, recentFiles, userResult] = await Promise.all([
            listFolder(userId, null),
            getRecentFiles(userId, 10),
            pool.query('SELECT display_name FROM users WHERE id = $1', [userId]),
        ]);
        const displayName = userResult.rows[0]?.display_name || 'User';
        res.render('landing', {
            layout: false,
            initialItems: JSON.stringify(folderContents),
            recentFiles: JSON.stringify(recentFiles),
            displayName,
        });
    }
    catch (err) {
        next(err);
    }
});
//# sourceMappingURL=landing.js.map