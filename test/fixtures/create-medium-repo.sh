#!/bin/bash
# Creates a medium "sudoku generator" Python project with ~15 commits
set -e

DIR="${1:-/tmp/test-repo-medium}"
rm -rf "$DIR"
mkdir -p "$DIR"
cd "$DIR"
git init
git config user.email "dev@sudoku.com"
git config user.name "Sudoku Dev"

# Commit 1: Project scaffold
mkdir -p src tests output
cat > README.md << 'MDEOF'
# Sudoku Generator
Generates solved Sudoku puzzles and exports them as formatted text or PDF.
MDEOF
cat > requirements.txt << 'PYEOF'
reportlab>=4.0
PYEOF
cat > src/__init__.py << 'PYEOF'
PYEOF
cat > tests/__init__.py << 'PYEOF'
PYEOF
git add -A && git commit -m "Initial project scaffold"

# Commit 2: Sudoku grid data structure
cat > src/grid.py << 'PYEOF'
"""Sudoku grid representation."""

class SudokuGrid:
    def __init__(self):
        self.cells = [[0] * 9 for _ in range(9)]

    def get(self, row: int, col: int) -> int:
        return self.cells[row][col]

    def set(self, row: int, col: int, value: int) -> None:
        self.cells[row][col] = value

    def is_valid_placement(self, row: int, col: int, num: int) -> bool:
        # Check row
        if num in self.cells[row]:
            return False
        # Check column
        if num in [self.cells[r][col] for r in range(9)]:
            return False
        # Check 3x3 box
        box_row, box_col = 3 * (row // 3), 3 * (col // 3)
        for r in range(box_row, box_row + 3):
            for c in range(box_col, box_col + 3):
                if self.cells[r][c] == num:
                    return False
        return True

    def is_complete(self) -> bool:
        return all(self.cells[r][c] != 0 for r in range(9) for c in range(9))

    def copy(self) -> "SudokuGrid":
        new_grid = SudokuGrid()
        new_grid.cells = [row[:] for row in self.cells]
        return new_grid
PYEOF
git add -A && git commit -m "Add SudokuGrid data structure with validation"

# Commit 3: Backtracking solver/generator
cat > src/generator.py << 'PYEOF'
"""Sudoku puzzle generator using backtracking."""
import random
from .grid import SudokuGrid

def generate_solved_puzzle() -> SudokuGrid:
    grid = SudokuGrid()
    _fill_grid(grid)
    return grid

def _fill_grid(grid: SudokuGrid) -> bool:
    for row in range(9):
        for col in range(9):
            if grid.get(row, col) == 0:
                numbers = list(range(1, 10))
                random.shuffle(numbers)
                for num in numbers:
                    if grid.is_valid_placement(row, col, num):
                        grid.set(row, col, num)
                        if _fill_grid(grid):
                            return True
                        grid.set(row, col, 0)
                return False
    return True
PYEOF
git add -A && git commit -m "Implement backtracking puzzle generator"

# Commit 4: Text formatter
cat > src/formatter.py << 'PYEOF'
"""Format sudoku grids as text."""
from .grid import SudokuGrid

def format_text(grid: SudokuGrid) -> str:
    lines = []
    separator = "+-------+-------+-------+"
    for row in range(9):
        if row % 3 == 0:
            lines.append(separator)
        parts = []
        for col in range(9):
            if col % 3 == 0:
                parts.append("|")
            val = grid.get(row, col)
            parts.append(f" {val if val != 0 else '.'}")
        parts.append("|")
        lines.append("".join(parts))
    lines.append(separator)
    return "\n".join(lines)
PYEOF
git add -A && git commit -m "Add text formatter for grid display"

# Commit 5: Main entry point
cat > src/main.py << 'PYEOF'
"""Main entry point for sudoku generator."""
from .generator import generate_solved_puzzle
from .formatter import format_text

def main():
    print("Generating a new Sudoku puzzle...\n")
    puzzle = generate_solved_puzzle()
    print(format_text(puzzle))

if __name__ == "__main__":
    main()
PYEOF
git add -A && git commit -m "Add main entry point"

# Commit 6: Tests for grid
cat > tests/test_grid.py << 'PYEOF'
from src.grid import SudokuGrid

def test_empty_grid():
    grid = SudokuGrid()
    assert grid.get(0, 0) == 0
    assert not grid.is_complete()

def test_valid_placement():
    grid = SudokuGrid()
    assert grid.is_valid_placement(0, 0, 1)
    grid.set(0, 0, 1)
    assert not grid.is_valid_placement(0, 1, 1)  # same row
    assert not grid.is_valid_placement(1, 0, 1)  # same col
    assert not grid.is_valid_placement(1, 1, 1)  # same box

def test_copy():
    grid = SudokuGrid()
    grid.set(0, 0, 5)
    copy = grid.copy()
    assert copy.get(0, 0) == 5
    copy.set(0, 0, 9)
    assert grid.get(0, 0) == 5  # original unchanged
PYEOF
git add -A && git commit -m "Add grid unit tests"

# Commit 7: Tests for generator
cat > tests/test_generator.py << 'PYEOF'
from src.generator import generate_solved_puzzle

def test_generates_complete_puzzle():
    puzzle = generate_solved_puzzle()
    assert puzzle.is_complete()

def test_generates_valid_puzzle():
    puzzle = generate_solved_puzzle()
    for row in range(9):
        nums = [puzzle.get(row, col) for col in range(9)]
        assert sorted(nums) == list(range(1, 10))
    for col in range(9):
        nums = [puzzle.get(row, col) for row in range(9)]
        assert sorted(nums) == list(range(1, 10))
PYEOF
git add -A && git commit -m "Add generator tests"

# Commit 8: PDF output
cat > src/pdf_export.py << 'PYEOF'
"""Export sudoku grid as PDF using reportlab."""
from .grid import SudokuGrid

def export_pdf(grid: SudokuGrid, filename: str = "sudoku.pdf") -> str:
    try:
        from reportlab.lib.pagesizes import letter
        from reportlab.pdfgen import canvas
    except ImportError:
        raise RuntimeError("reportlab is required for PDF export. Install with: pip install reportlab")

    c = canvas.Canvas(filename, pagesize=letter)
    width, height = letter

    # Title
    c.setFont("Helvetica-Bold", 24)
    c.drawCentredString(width / 2, height - 60, "Sudoku Puzzle")

    # Grid
    cell_size = 40
    start_x = (width - 9 * cell_size) / 2
    start_y = height - 120

    c.setFont("Helvetica", 18)
    for row in range(9):
        for col in range(9):
            x = start_x + col * cell_size
            y = start_y - row * cell_size

            # Draw cell border
            line_width = 2 if (col % 3 == 0) else 0.5
            c.setLineWidth(line_width)
            c.rect(x, y - cell_size, cell_size, cell_size)

            # Draw number
            val = grid.get(row, col)
            if val != 0:
                c.drawCentredString(x + cell_size / 2, y - cell_size + 12, str(val))

    # Draw thick borders for 3x3 boxes
    c.setLineWidth(3)
    for i in range(4):
        c.line(start_x + i * 3 * cell_size, start_y,
               start_x + i * 3 * cell_size, start_y - 9 * cell_size)
        c.line(start_x, start_y - i * 3 * cell_size,
               start_x + 9 * cell_size, start_y - i * 3 * cell_size)

    c.save()
    return filename
PYEOF
git add -A && git commit -m "Add PDF export with reportlab"

# Commit 9: Wire PDF into main
cat > src/main.py << 'PYEOF'
"""Main entry point for sudoku generator."""
import argparse
from .generator import generate_solved_puzzle
from .formatter import format_text
from .pdf_export import export_pdf

def main():
    parser = argparse.ArgumentParser(description="Generate Sudoku puzzles")
    parser.add_argument("--pdf", type=str, help="Export to PDF file")
    parser.add_argument("--count", type=int, default=1, help="Number of puzzles")
    args = parser.parse_args()

    for i in range(args.count):
        puzzle = generate_solved_puzzle()

        if args.pdf:
            filename = args.pdf if args.count == 1 else f"sudoku_{i+1}.pdf"
            export_pdf(puzzle, filename)
            print(f"Exported to {filename}")
        else:
            if i > 0:
                print()
            print(format_text(puzzle))

if __name__ == "__main__":
    main()
PYEOF
git add -A && git commit -m "Add CLI args for PDF export and multiple puzzles"

# Commit 10: Difficulty levels
cat > src/difficulty.py << 'PYEOF'
"""Remove cells from a solved puzzle to create difficulty levels."""
import random
from .grid import SudokuGrid

DIFFICULTY_CELLS_TO_REMOVE = {
    "easy": 30,
    "medium": 45,
    "hard": 55,
}

def create_puzzle(solved: SudokuGrid, difficulty: str = "medium") -> SudokuGrid:
    cells_to_remove = DIFFICULTY_CELLS_TO_REMOVE.get(difficulty, 45)
    puzzle = solved.copy()

    positions = [(r, c) for r in range(9) for c in range(9)]
    random.shuffle(positions)

    for row, col in positions[:cells_to_remove]:
        puzzle.set(row, col, 0)

    return puzzle
PYEOF
git add -A && git commit -m "Add difficulty levels (easy/medium/hard)"

# Commit 11: Wire difficulty into main
cat > src/main.py << 'PYEOF'
"""Main entry point for sudoku generator."""
import argparse
from .generator import generate_solved_puzzle
from .formatter import format_text
from .pdf_export import export_pdf
from .difficulty import create_puzzle

def main():
    parser = argparse.ArgumentParser(description="Generate Sudoku puzzles")
    parser.add_argument("--pdf", type=str, help="Export to PDF file")
    parser.add_argument("--count", type=int, default=1, help="Number of puzzles")
    parser.add_argument("--difficulty", choices=["easy", "medium", "hard"], default="medium")
    parser.add_argument("--solved", action="store_true", help="Show solved puzzle (no blanks)")
    args = parser.parse_args()

    for i in range(args.count):
        solved = generate_solved_puzzle()
        puzzle = solved if args.solved else create_puzzle(solved, args.difficulty)

        if args.pdf:
            filename = args.pdf if args.count == 1 else f"sudoku_{i+1}.pdf"
            export_pdf(puzzle, filename)
            print(f"Exported to {filename}")
        else:
            if i > 0:
                print()
            print(format_text(puzzle))

if __name__ == "__main__":
    main()
PYEOF
git add -A && git commit -m "Wire difficulty into CLI"

# Commit 12: Puzzle validator
cat > src/validator.py << 'PYEOF'
"""Validate that a sudoku puzzle has a unique solution."""
from .grid import SudokuGrid

def count_solutions(grid: SudokuGrid, limit: int = 2) -> int:
    """Count solutions up to limit. Returns early if more than 1 found."""
    g = grid.copy()
    return _count(g, limit)

def _count(grid: SudokuGrid, limit: int) -> int:
    for row in range(9):
        for col in range(9):
            if grid.get(row, col) == 0:
                count = 0
                for num in range(1, 10):
                    if grid.is_valid_placement(row, col, num):
                        grid.set(row, col, num)
                        count += _count(grid, limit - count)
                        grid.set(row, col, 0)
                        if count >= limit:
                            return count
                return count
    return 1

def has_unique_solution(grid: SudokuGrid) -> bool:
    return count_solutions(grid, 2) == 1
PYEOF
git add -A && git commit -m "Add puzzle validator for unique solutions"

# Commit 13: Update README with full docs
cat > README.md << 'MDEOF'
# Sudoku Generator

A Python application that generates Sudoku puzzles with configurable difficulty and exports them as formatted text or PDF.

## Architecture

- `src/grid.py` - Core grid data structure with validation
- `src/generator.py` - Backtracking puzzle generator
- `src/difficulty.py` - Difficulty level management
- `src/validator.py` - Unique solution validator
- `src/formatter.py` - Text output formatting
- `src/pdf_export.py` - PDF export via reportlab

## Usage

```bash
# Print a medium difficulty puzzle
python -m src.main

# Generate an easy puzzle as PDF
python -m src.main --difficulty easy --pdf puzzle.pdf

# Generate 5 hard puzzles
python -m src.main --difficulty hard --count 5

# Show solved puzzle
python -m src.main --solved
```

## Testing

```bash
pytest tests/
```
MDEOF
git add -A && git commit -m "Update README with full documentation"

# Commit 14: Bug fix in formatter
cat > src/formatter.py << 'PYEOF'
"""Format sudoku grids as text."""
from .grid import SudokuGrid

HORIZONTAL_SEP = "+-------+-------+-------+"

def format_text(grid: SudokuGrid, show_zeros: bool = False) -> str:
    lines = []
    for row in range(9):
        if row % 3 == 0:
            lines.append(HORIZONTAL_SEP)
        parts = []
        for col in range(9):
            if col % 3 == 0:
                parts.append("|")
            val = grid.get(row, col)
            display = str(val) if (val != 0 or show_zeros) else "."
            parts.append(f" {display}")
        parts.append("|")
        lines.append("".join(parts))
    lines.append(HORIZONTAL_SEP)
    return "\n".join(lines)
PYEOF
git add -A && git commit -m "Fix formatter: add show_zeros option, extract separator constant"

# Commit 15: Add type hints and cleanup
cat > src/__init__.py << 'PYEOF'
"""Sudoku Generator - Generate and export Sudoku puzzles."""
from .generator import generate_solved_puzzle
from .difficulty import create_puzzle
from .formatter import format_text
from .pdf_export import export_pdf
from .validator import has_unique_solution

__all__ = [
    "generate_solved_puzzle",
    "create_puzzle",
    "format_text",
    "export_pdf",
    "has_unique_solution",
]
PYEOF
git add -A && git commit -m "Add package exports and type hints cleanup"

echo "Created medium test repo at $DIR with $(git rev-list --count HEAD) commits"
