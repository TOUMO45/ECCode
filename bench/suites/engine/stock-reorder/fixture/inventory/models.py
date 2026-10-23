from dataclasses import dataclass


@dataclass
class Product:
    sku: str
    name: str
    qty: int
    updated: str

    @staticmethod
    def from_dict(d):
        return Product(sku=d["sku"], name=d["name"], qty=int(d["qty"]), updated=d["updated"])

    def to_dict(self):
        return {"sku": self.sku, "name": self.name, "qty": self.qty, "updated": self.updated}
