class Problem(Exception):
    def __init__(self, status: int, code: str, detail: str):
        super().__init__(detail)
        self.status = status
        self.code = code
        self.detail = detail


def not_found() -> Problem:
    return Problem(404, "not_found", "The resource does not exist or is not accessible.")
