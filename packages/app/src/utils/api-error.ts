
class ApiError extends Error {

    readonly statusCode: number
    readonly errors: unknown
    
    constructor(
        statusCode: number,
        message = "something went wrong",
        errors: unknown = undefined,
        stack?: string
    ){
        super(message)
            this.name = "ApiError"
            this.statusCode = statusCode
            this.errors = errors

            if(stack){
                this.stack = stack
            } else {
                Error.captureStackTrace(this, this.constructor)
            };

            
        };

        
};

export default ApiError
