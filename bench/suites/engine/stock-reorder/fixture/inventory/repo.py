import json

from inventory.models import Product


def load_products(path):
    with open(path, encoding="utf-8") as f:
        return [Product.from_dict(d) for d in json.load(f)]


def save_products(path, products):
    with open(path, "w", encoding="utf-8") as f:
        json.dump([p.to_dict() for p in products], f, indent=2)
