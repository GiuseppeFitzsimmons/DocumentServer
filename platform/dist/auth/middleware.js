export function requireAuth(req, res, next) {
    if (!req.session.userId) {
        // If it's an API request, return JSON
        if (req.path.startsWith('/auth/') || req.headers.accept?.includes('application/json')) {
            res.status(401).json({ error: 'Unauthorized' });
            return;
        }
        // Otherwise redirect to home
        res.redirect('/home');
        return;
    }
    next();
}
//# sourceMappingURL=middleware.js.map