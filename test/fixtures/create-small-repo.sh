#!/bin/bash
# Creates a small "hello world" Python project with 5 commits
set -e

DIR="${1:-/tmp/test-repo-small}"
rm -rf "$DIR"
mkdir -p "$DIR"
cd "$DIR"
git init
git config user.email "test@test.com"
git config user.name "Test Developer"

# Commit 1: Initial setup
cat > main.py << 'PYEOF'
print("Hello, World!")
PYEOF
cat > README.md << 'MDEOF'
# Hello World
A simple Python hello world program.
MDEOF
git add -A && git commit -m "Initial hello world"

# Commit 2: Add greeting function
cat > main.py << 'PYEOF'
def greet(name: str) -> str:
    return f"Hello, {name}!"

if __name__ == "__main__":
    print(greet("World"))
PYEOF
git add -A && git commit -m "Refactor into greeting function"

# Commit 3: Add config
cat > config.py << 'PYEOF'
DEFAULT_NAME = "World"
GREETING_TEMPLATE = "Hello, {name}!"
PYEOF
cat > main.py << 'PYEOF'
from config import DEFAULT_NAME, GREETING_TEMPLATE

def greet(name: str = DEFAULT_NAME) -> str:
    return GREETING_TEMPLATE.format(name=name)

if __name__ == "__main__":
    import sys
    name = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_NAME
    print(greet(name))
PYEOF
git add -A && git commit -m "Extract config, add CLI argument support"

# Commit 4: Add tests
cat > test_main.py << 'PYEOF'
from main import greet

def test_default_greeting():
    assert greet() == "Hello, World!"

def test_custom_greeting():
    assert greet("Alice") == "Hello, Alice!"
PYEOF
git add -A && git commit -m "Add unit tests"

# Commit 5: Add requirements and update README
cat > requirements.txt << 'PYEOF'
pytest>=7.0
PYEOF
cat > README.md << 'MDEOF'
# Hello World

A simple Python hello world program with configurable greetings.

## Usage
```bash
python main.py [name]
```

## Testing
```bash
pytest test_main.py
```
MDEOF
git add -A && git commit -m "Add requirements.txt and update README"

echo "Created small test repo at $DIR with $(git rev-list --count HEAD) commits"
