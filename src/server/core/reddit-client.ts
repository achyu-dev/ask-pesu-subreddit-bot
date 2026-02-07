import { reddit } from '@devvit/web/server';

export type AskPESUResponse = {
  status: boolean;
  answer?: string;
};

export type QuotaResponse = {
  quota: {
    thinking: { available: boolean };
    primary: { available: boolean };
  };
};

export const queryAskPESU = async (title: string, content: string): Promise<AskPESUResponse> => {
  const query = `${title}\n\n${content || ''}`.trim();
  const baseURL = process.env.ASK_PESU_URL;

  if (!baseURL) {
    console.error('ASK_PESU_URL environment variable not set');
    return { status: false };
  }

  try {
    const quotaResponse = await fetch(`${baseURL}/quota`);
    if (!quotaResponse.ok) {
      console.error(`Failed to fetch quota: ${quotaResponse.statusText}`);
      return { status: false };
    }
    const quotaData = (await quotaResponse.json()) as QuotaResponse;

    let thinking = false;

    if (quotaData.quota.thinking.available) {
      thinking = true;
    } else if (!quotaData.quota.primary.available) {
      console.warn('No models available for processing the request');
      return { status: false };
    }

    // query the askpesu API
    const askRes = await fetch(`${baseURL}/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, thinking }),
    });

    if (!askRes.ok) {
      console.error('Failed to query AskPESU API');
      return { status: false };
    }

    return (await askRes.json()) as AskPESUResponse;
  } catch (error) {
    console.error('Error querying AskPESU API:', error);
    return { status: false };
  }
};

export const processNewPost = async (
  postId: `t3_${string}`,
  title: string,
  content: string
): Promise<{ replied: boolean; answer?: string }> => {
  try {
    const response = await queryAskPESU(title, content);

    // Check if response is valid and not the default fallback
    if (
      response.status &&
      response.answer &&
      response.answer !== "I'm sorry, I don't have that information."
    ) {
      const answer = `${response.answer}\n\n---\n*I am a bot, and this action was performed automatically.*`;

      // Reply to the post using Devvit's Reddit API
      await reddit.submitComment({
        id: postId,
        text: answer,
      });

      console.log(`Replied to post: ${postId} - ${title}`);
      return { replied: true, answer };
    }

    return { replied: false };
  } catch (error) {
    console.error(`Failed to process post: ${postId} - ${title}`, error);
    return { replied: false };
  }
};
