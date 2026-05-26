export class ConvertError extends Error {
  readonly status: number
  readonly code?: string

  constructor(status: number, message: string, code?: string) {
    super(message)
    this.name = 'ConvertError'
    this.status = status
    this.code = code
  }
}
