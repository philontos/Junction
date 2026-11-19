export class CloudError extends Error { constructor(public status: number, message: string) { super(message); } }
