class ApiResponse<T = unknown> {
  statusCode: number;
  message: string;
  data: T;
  success: boolean;

  constructor(
    statusCode: number,
    message: string,
    data: T
  ) {
    this.statusCode = statusCode;
    this.message = message;
    this.data = data;
    this.success = statusCode < 400;
  }
}

export default ApiResponse;