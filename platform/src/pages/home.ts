import { Router } from 'express';

export const homeRouter = Router();

homeRouter.get('/home', (req, res) => {
  if (req.session.userId) {
    res.redirect('/');
    return;
  }
  res.render('home', { layout: false });
});
