app.get('/api/instagram', async (req, res) => {
  try {
    const token = process.env.META_ACCESS_TOKEN;

    // Step 1: get pages
    const meRes = await fetch(`https://graph.facebook.com/v19.0/me/accounts?access_token=${token}`);
    const meData = await meRes.json();

    // Return raw data so we can see what's coming back
    if (!meData.data || meData.data.length === 0) {
      return res.json({ debug: 'no_pages_found', raw: meData });
    }

    const pageId = meData.data[0].id;
    const pageToken = meData.data[0].access_token;
    const pageName = meData.data[0].name;

    // Step 2: get IG business account
    const igRes = await fetch(`https://graph.facebook.com/v19.0/${pageId}?fields=instagram_business_account&access_token=${pageToken}`);
    const igData = await igRes.json();

    if (!igData.instagram_business_account) {
      return res.json({ debug: 'no_ig_account', page: pageName, pageId, raw: igData });
    }

    const igId = igData.instagram_business_account.id;

    const [insightsRes, profileRes, mediaRes] = await Promise.all([
      fetch(`https://graph.facebook.com/v19.0/${igId}/insights?metric=impressions,reach,profile_views,follower_count,website_clicks&period=day&access_token=${pageToken}`),
      fetch(`https://graph.facebook.com/v19.0/${igId}?fields=followers_count,media_count,username&access_token=${pageToken}`),
      fetch(`https://graph.facebook.com/v19.0/${igId}/media?fields=id,caption,media_type,timestamp,like_count,comments_count,insights.metric(impressions,reach,saved,shares)&limit=10&access_token=${pageToken}`),
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
