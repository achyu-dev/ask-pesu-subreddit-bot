export type BotStatusResponse = {
  status: boolean;
  message: string;
  timestamp: string;
};

export type ProcessPostRequest = {
  postId: `t3_${string}`;
  title: string;
  content: string;
};

export type ProcessPostResponse = {
  status: boolean;
  replied: boolean;
  answer?: string;
  message?: string;
};

export type HealthResponse = {
  status: boolean;
  message: string;
  timestamp: string;
};