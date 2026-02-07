import 'dotenv/config';
import express from 'express';
import {
  InitResponse,
  IncrementResponse,
  DecrementResponse,
  BotStatusResponse,
  ProcessPostResponse,
  ProcessPostRequest,
  HealthResponse,
} from '../shared/types/api';
import { redis, reddit, createServer, context, getServerPort } from '@devvit/web/server';
import { createPost } from './core/post';
import { processNewPost } from './core/reddit-client';

const app = express();

// Middleware for JSON body parsing
app.use(express.json());
// Middleware for URL-encoded body parsing
app.use(express.urlencoded({ extended: true }));
// Middleware for plain text body parsing
app.use(express.text());

const router = express.Router();

// Health check endpoint
router.get<object, HealthResponse>('/api/health', async (_req, res): Promise<void> => {
  res.json({
    status: true,
    message: 'ok',
    timestamp: new Date().toISOString(),
  });
});

// Bot status endpoint
router.get<object, BotStatusResponse>('/api/bot/status', async (_req, res): Promise<void> => {
  try {
    const processedCount = await redis.get('bot:processed_count');
    res.json({
      status: true,
      message: `Bot is running. Processed ${processedCount || 0} posts.`,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Error getting bot status:', error);
    res.status(500).json({
      status: false,
      message: 'Failed to get bot status',
      timestamp: new Date().toISOString(),
    });
  }
});

// Process a specific post
router.post<object, ProcessPostResponse, ProcessPostRequest>(
  '/api/bot/process-post',
  async (req, res): Promise<void> => {
    const { postId, title, content } = req.body;

    if (!postId || !title) {
      res.status(400).json({
        status: false,
        replied: false,
        message: 'postId and title are required',
      });
      return;
    }

    try {
      const result = await processNewPost(postId, title, content);

      if (result.replied) {
        // Increment processed count
        await redis.incrBy('bot:processed_count', 1);
        // Store the last processed post
        await redis.set(
          'bot:last_processed',
          JSON.stringify({
            postId,
            title,
            timestamp: new Date().toISOString(),
          })
        );
      }

      res.json({
        status: true,
        replied: result.replied,
        ...(result.answer ? { answer: result.answer } : {}),
        message: result.replied ? 'Successfully replied to post' : 'No reply generated',
      });
    } catch (error) {
      console.error('Error processing post:', error);
      res.status(500).json({
        status: false,
        replied: false,
        message: 'Failed to process post',
      });
    }
  }
);

router.get<{ postId: string }, InitResponse | { status: string; message: string }>(
  '/api/init',
  async (_req, res): Promise<void> => {
    const { postId } = context;

    if (!postId) {
      console.error('API Init Error: postId not found in devvit context');
      res.status(400).json({
        status: 'error',
        message: 'postId is required but missing from context',
      });
      return;
    }

    try {
      const [count, username] = await Promise.all([
        redis.get('count'),
        reddit.getCurrentUsername(),
      ]);

      res.json({
        type: 'init',
        postId: postId,
        count: count ? parseInt(count) : 0,
        username: username ?? 'anonymous',
      });
    } catch (error) {
      console.error(`API Init Error for post ${postId}:`, error);
      let errorMessage = 'Unknown error during initialization';
      if (error instanceof Error) {
        errorMessage = `Initialization failed: ${error.message}`;
      }
      res.status(400).json({ status: 'error', message: errorMessage });
    }
  }
);

router.post<{ postId: string }, IncrementResponse | { status: string; message: string }, unknown>(
  '/api/increment',
  async (_req, res): Promise<void> => {
    const { postId } = context;
    if (!postId) {
      res.status(400).json({
        status: 'error',
        message: 'postId is required',
      });
      return;
    }

    res.json({
      count: await redis.incrBy('count', 1),
      postId,
      type: 'increment',
    });
  }
);

router.post<{ postId: string }, DecrementResponse | { status: string; message: string }, unknown>(
  '/api/decrement',
  async (_req, res): Promise<void> => {
    const { postId } = context;
    if (!postId) {
      res.status(400).json({
        status: 'error',
        message: 'postId is required',
      });
      return;
    }

    res.json({
      count: await redis.incrBy('count', -1),
      postId,
      type: 'decrement',
    });
  }
);

router.post('/internal/on-app-install', async (_req, res): Promise<void> => {
  try {
    const post = await createPost();

    res.json({
      status: 'success',
      message: `Post created in subreddit ${context.subredditName} with id ${post.id}`,
    });
  } catch (error) {
    console.error(`Error creating post: ${error}`);
    res.status(400).json({
      status: 'error',
      message: 'Failed to create post',
    });
  }
});

router.post('/internal/menu/post-create', async (_req, res): Promise<void> => {
  try {
    const post = await createPost();

    res.json({
      navigateTo: `https://reddit.com/r/${context.subredditName}/comments/${post.id}`,
    });
  } catch (error) {
    console.error(`Error creating post: ${error}`);
    res.status(400).json({
      status: 'error',
      message: 'Failed to create post',
    });
  }
});

// trigger for new posts
router.post('/internal/on-post-submit', async (req, res): Promise<void> => {
  try {
    console.log('on-post-submit trigger received:', JSON.stringify(req.body));
    
    // Extract post info from the trigger event body
    const event = req.body;
    
    // The trigger event contains post information
    // Structure: { post: { id, title, body, ... }, author: { id, name }, subreddit: { id, name } }
    const postId = event?.post?.id || event?.postId;
    const title = event?.post?.title || event?.title;
    const body = event?.post?.body || event?.selftext || event?.content || '';
    
    if (!postId) {
      console.error('on-post-submit: postId not found in event body', event);
      res.status(400).json({
        status: 'error',
        message: 'postId not found in trigger event',
      });
      return;
    }

    console.log(`Processing new post: ${postId} - ${title}`);

    // Process the post with AskPESU
    const result = await processNewPost(postId, title, body);

    if (result.replied) {
      await redis.incrBy('bot:processed_count', 1);
      await redis.set('bot:last_processed', JSON.stringify({
        postId,
        title,
        timestamp: new Date().toISOString(),
      }));
    }

    res.json({
      status: 'success',
      replied: result.replied,
      message: result.replied ? 'Replied to post' : 'No reply generated',
    });
  } catch (error) {
    console.error('Error handling post submit trigger:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to process new post',
    });
  }
});

// Use router middleware
app.use(router);

// Get port from environment variable with fallback
const port = getServerPort();

const server = createServer(app);
server.on('error', (err) => console.error(`server error; ${err.stack}`));
server.listen(port);
