"""Generate ADMIN_PASSWORD_HASH interactively without shell history secrets."""
from getpass import getpass

from .auth import hash_password


def main() -> None:
    password = getpass("관리자 비밀번호: ")
    if password != getpass("비밀번호 확인: "):
        raise SystemExit("비밀번호가 일치하지 않습니다.")
    print(hash_password(password))


if __name__ == "__main__":
    main()
