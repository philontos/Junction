export interface LocalAccessRequest { user_id: string; username: string; task_id?: string }
export interface LocalAccessResult { url: string; expires_in: number }
