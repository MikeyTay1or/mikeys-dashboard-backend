const express = require('express');
const { google } = require('googleapis');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

// ─── Google OAuth client ───────────────────────────────────────────────────
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

// Load saved tokens if present
if (process.env.GOOGLE_REFRESH_TOKEN) {
  oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
}

// ─── Auth routes ───────────────────────────────────────────────────────────
app.get('/auth/google', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/youtube.readonly',
      'https://www.googleapis.com/auth/yt-analytics.readonly',
    ],
    prompt: 'consent',
  });
  res.redirect(url);
});

app.get('/auth/google/callback', async (req, res) => {
  const { code } = req.query;
  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);
  console.log('GOOGLE_REFRESH_TOKEN:', tokens.refresh_token);
  res.send(`
    <h2>YouTube connected!</h2>
    <p>Copy this refresh token into your Render environment variables as GOOGLE_REFRESH_TOKEN:</p>
    <pre style="background:#f0f0f0;padding:1rem;word-break:break-all">${tokens.refresh_token}</pre>
    <p>Then restart your Render service.</p>
  `);
});

app.get('/auth/instagram', (req, res) => {
  const url = `https://www.facebook.com/v19.0/dialog/oauth?client_id=${process.env.META_APP_ID}&redirect_uri=${encodeURIComponent(process.env.META_REDIRECT_URI)}&scope=instagram_basic,instagram_manage_insights,pages_show_list,pages_read_engagement&response_type=code`;
  res.redirect(url);
});

app.get('/auth/instagram/callback', async (req, res) => {
  const { code } = req.query;
  try {
    const tokenRes = await fetch(`https://graph.facebook.com/v19.0/oauth/access_token?client_id=${process.env.META_APP_ID}&redirect_uri=${encodeURIComponent(process.env.META_REDIRECT_URI)}&client_secret=${process.env.META_APP_SECRET}&code=${code}`);
    const tokenData = await tokenRes.json();

    const longRes = await fetch(`https://graph.facebook.com/v19.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${process.env.META_APP_ID}&client_secret=${process.env.META_APP_SECRET}&fb_exchange_token=${tokenData.access_token}`);
    const longData = await longRes.json();

    console.log('META_ACCESS_TOKEN:', longData.access_token);
    res.send(`
      <h2>Instagram connected!</h2>
      <p>Copy this access token into your Render environment variables as META_ACCESS_TOKEN:</p>
      <pre style="background:#f0f0f0;padding:1rem;word-break:break-all">${longData.access_token}</pre>
      <p>Then restart your Render service.</p>
    `);
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

// ─── YouTube data ──────────────────────────────────────────────────────────
app.get('/api/youtube', async (req, res) => {
  try {
    const { days = 30 } = req.query;
    const endDate = new Date().toISOString().split('T')[0];
    const startDate = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];

    const ytAnalytics = google.youtubeAnalytics({ version: 'v2', auth: oauth2Client });
    const ytData = google.youtube({ version: 'v3', auth: oauth2Client });

    const [analytics, channelRes, topVideos] = await Promise.all([
      ytAnalytics.reports.query({
        ids: 'channel==MINE',
        startDate,
        endDate,
        metrics: 'views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained,subscribersLost,likes,comments,shares',
        dimensions: 'day',
      }),
      ytData.channels.list({ part: 'statistics', mine: true }),
      ytAnalytics.reports.query({
        ids: 'channel==MINE',
        startDate,
        endDate,
        metrics: 'views,estimatedMinutesWatched,averageViewPercentage,likes,comments,shares',
        dimensions: 'video',
        sort: '-views',
        maxResults: 5,
      }),
    ]);

    const stats = channelRes.data.items[0].statistics;

    res.json({
      platform: 'youtube',
      summary: {
        subscribers: parseInt(stats.subscriberCount),
        totalViews: parseInt(stats.viewCount),
        periodViews: analytics.data.rows?.reduce((s, r) => s + r[1], 0) || 0,
        watchTimeHours: Math.round((analytics.data.rows?.reduce((s, r) => s + r[2], 0) || 0) / 60),
        avgWatchPercent: Math.round(analytics.data.rows?.reduce((s, r) => s + r[4], 0) / (analytics.data.rows?.length || 1)),
        subscribersGained: analytics.data.rows?.reduce((s, r) => s + r[5], 0) || 0,
        likes: analytics.data.rows?.reduce((s, r) => s + r[7], 0) || 0,
        comments: analytics.data.rows?.reduce((s, r) => s + r[8], 0) || 0,
        shares: analytics.data.rows?.reduce((s, r) => s + r[9], 0) || 0,
      },
      dailyData: analytics.data.rows?.map(r => ({
        date: r[0], views: r[1], watchMinutes: r[2], avgViewDuration: r[3],
        avgViewPercent: r[4], subscribersGained: r[5], subscribersLost: r[6],
        likes: r[7], comments: r[8], shares: r[9],
      })) || [],
      topVideos: topVideos.data.rows?.map(r => ({
        videoId: r[0], views: r[1], watchMinutes: r[2],
        avgViewPercent: r[3], likes: r[4], comments: r[5], shares: r[6],
      })) || [],
    });
  } catch (err) {
    console.error('YouTube error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Instagram data ────────────────────────────────────────────────────────
app.get('/api/instagram', async (req, res) => {
  try {
    const token = process.env.META_ACCESS_TOKEN;

    const meRes = await fetch(`https://graph.facebook.com/v19.0/me/accounts?access_token=${token}`);
    const meData = await meRes.json();

    if (!meData.data || meData.data.length === 0) {
      return res.json({ debug: 'no_pages_found', raw: meData });
    }

    const pageId = meData.data[0].id;
    const pageToken = meData.data[0].access_token;
    const pageName = meData.data[0].name;

    const igRes = await fetch(`https://graph.facebook.com/v19.0/${pageId}?fields=instagram_business_account&access_token=${pageToken}`);
    const igData = await igRes.json();

    if (!igData.instagram_business_account) {
      return res.json({ debug: 'no_ig_account', raw: igData });
    }

    const igId = igData.instagram_business_account.id;

    const [insightsRes, profileRes, mediaRes] = await Promise.all([
      fetch(`https://graph.facebook.com/v19.0/${igId}/insights?metric=impressions,reach,profile_views,follower_count,website_clicks&period=day&access_token=${token}`),
      fetch(`https://graph.facebook.com/v19.0/${igId}?fields=followers_count,media_count,username&access_token=${token}`),
      fetch(`https://graph.facebook.com/v19.0/${igId}/media?fields=id,caption,media_type,timestamp,like_count,comments_count,insights.metric(impressions,reach,saved,shares)&limit=10&access_token=${token}`),
    ]);

    const [insights, profile, media] = await Promise.all([
      insightsRes.json(), profileRes.json(), mediaRes.json()
    ]);

    const getMetric = (name) => insights.data?.find(d => d.name === name)?.values?.reduce((s, v) => s + v.value, 0) || 0;

    res.json({
      platform: 'instagram',
      summary: {
        followers: profile.followers_count,
        username: profile.username,
        impressions: getMetric('impressions'),
        reach: getMetric('reach'),
        profileViews: getMetric('profile_views'),
        websiteClicks: getMetric('website_clicks'),
      },
      topPosts: media.data?.map(post => {
        const ins = post.insights?.data || [];
        const get = (n) => ins.find(d => d.name === n)?.values?.[0]?.value || 0;
        return {
          id: post.id,
          caption: post.caption?.substring(0, 80) || '',
          type: post.media_type,
          timestamp: post.timestamp,
          likes: post.like_count,
          comments: post.comments_count,
          impressions: get('impressions'),
          reach: get('reach'),
          saves: get('saved'),
          shares: get('shares'),
        };
      }) || [],
    });
  } catch (err) {
    console.error('Instagram error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Combined endpoint ─────────────────────────────────────────────────────
app.get('/api/all', async (req, res) => {
  const { days = 30 } = req.query;
  const base = `http://localhost:${process.env.PORT || 3000}`;
  try {
    const [yt, ig] = await Promise.all([
      fetch(`${base}/api/youtube?days=${days}`).then(r => r.json()),
      fetch(`${base}/api/instagram?days=${days}`).then(r => r.json()),
    ]);
    res.json({ youtube: yt, instagram: ig, fetchedAt: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.get('/', (req, res) => res.send('<html><head><title>Mikey Dashboard</title></head><body><h1>Mikey\'s Dashboard API</h1><p>Status: running</p></body></html>'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Dashboard backend running on port ${PORT}`));
