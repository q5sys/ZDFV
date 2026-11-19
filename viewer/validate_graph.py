#!/usr/bin/env python3
"""
Validate graph.json against the spec and a checkout of the pinned commit
(spec section 12, step 2).

Usage (from the viewer directory):
    python3 validate_graph.py [--graph graph.json]
                              [--spec ../zfs-io-flow-diagram-spec.md]
                              [--repo ../zfs]

Exits non-zero and lists every failure when a check does not pass.
"""

import argparse
import itertools
import json
import os
import re
import sys

import build_graph

HERE = os.path.dirname(os.path.abspath(__file__))


class Report:
    def __init__(self):
        self.failures = []
        self.passed = 0

    def check(self, condition, message):
        if condition:
            self.passed += 1
        else:
            self.failures.append(message)


def connected(wire_ids, wires_by_id):
    neighbours = {}
    for wire_id in wire_ids:
        wire = wires_by_id[wire_id]
        neighbours.setdefault(wire["from"], set()).add(wire["to"])
        neighbours.setdefault(wire["to"], set()).add(wire["from"])
    if not neighbours:
        return True
    start = next(iter(neighbours))
    seen = {start}
    stack = [start]
    while stack:
        node = stack.pop()
        for other in neighbours[node]:
            if other not in seen:
                seen.add(other)
                stack.append(other)
    return seen == set(neighbours)


def played_steps(path, selection):
    played = []
    for step in path["steps"]:
        ok = True
        for tag in step.get("when", []):
            if selection.get(tag["group"]) not in tag["options"]:
                ok = False
        if ok:
            played.append(step)
    return played


def default_selection(path):
    return {group["id"]: group["options"][0]["id"] for group in path["alts"]}


def all_selections(path):
    groups = path["alts"]
    choices = [[option["id"] for option in group["options"]] for group in groups]
    for combo in itertools.product(*choices):
        yield dict(zip([group["id"] for group in groups], combo))


def is_defined_at(lines, number, name):
    if number < 1 or number > len(lines):
        return False
    text = lines[number - 1]
    return bool(re.match(r"^(\w[\w\s\*]*[\s\*])?" + re.escape(name) + r"\s*\(", text))


def expected_counts(spec_lines):
    counts = {}
    degrees = []
    path_numbers = []
    for line in build_graph.section_lines(spec_lines, "## 13.", "## Appendix A"):
        if line.startswith("- Counts:"):
            for number, label in re.findall(r"(\d+) ([a-z][a-z ]+?)(?:[,.(]|$)", line):
                counts[label.strip()] = int(number)
        for node, n_in, rest in re.findall(
                r"Node `(\w+)` lists (?:(\d+) incoming)?(.*?)(?:\.|$)", line):
            n_out = re.search(r"(\d+) outgoing", rest)
            degrees.append((node, int(n_in) if n_in else None,
                            int(n_out.group(1)) if n_out else None))
        for path_id, wires, steps in re.findall(
                r"`(\w+)`[^;]*? highlights (\d+) (?:distinct wires )?(?:and plays (\d+))?", line):
            path_numbers.append((path_id, int(wires), int(steps) if steps else None))
    return counts, degrees, path_numbers


def validate_page(graph, spec_lines, repo, report):
    """All single-page checks of spec section 12, step 2."""
    nodes_by_id = {node["id"]: node for node in graph["nodes"]}
    wires_by_id = {}
    type_ids = {t["id"] for t in graph["types"]}
    group_ids = {g["id"] for g in graph["groups"]}
    context_ids = {c["id"] for c in graph["contexts"]}

    # Nodes
    for node in graph["nodes"]:
        report.check(node["group"] in group_ids, "node %s: unknown group" % node["id"])
        report.check(node["ctx"] in context_ids, "node %s: unknown context" % node["id"])

    # Wires
    for wire in graph["wires"]:
        report.check(wire["id"] not in wires_by_id, "wire id %s is not unique" % wire["id"])
        wires_by_id[wire["id"]] = wire
        report.check(wire["from"] in nodes_by_id, "wire %s: unknown source" % wire["id"])
        report.check(wire["to"] in nodes_by_id, "wire %s: unknown target" % wire["id"])
        report.check(wire["type"] in type_ids, "wire %s: unknown type" % wire["id"])
        report.check(len(wire["refs"]) > 0, "wire %s: no Appendix C reference" % wire["id"])

    used_nodes = set()
    for wire in graph["wires"]:
        used_nodes.add(wire["from"])
        used_nodes.add(wire["to"])
    for node_id in nodes_by_id:
        report.check(node_id in used_nodes, "node %s has no wire" % node_id)

    # Paths
    on_path = {}
    for path in graph["paths"]:
        group_options = {g["id"]: {o["id"] for o in g["options"]} for g in path["alts"]}
        for index, step in enumerate(path["steps"], 1):
            report.check(step["wire"] in wires_by_id,
                         "path %s step %d: unknown wire %s" % (path["id"], index, step["wire"]))
            on_path.setdefault(step["wire"], set()).add(path["id"])
            seen_groups = set()
            for tag in step.get("when", []):
                report.check(tag["group"] in group_options,
                             "path %s step %d: undeclared group %s" % (path["id"], index, tag["group"]))
                report.check(tag["group"] not in seen_groups,
                             "path %s step %d: two tags for group %s" % (path["id"], index, tag["group"]))
                seen_groups.add(tag["group"])
                for option in tag["options"]:
                    report.check(option in group_options.get(tag["group"], set()),
                                 "path %s step %d: unknown option %s" % (path["id"], index, option))
        for selection in all_selections(path):
            wire_ids = [s["wire"] for s in played_steps(path, selection)]
            report.check(connected(wire_ids, wires_by_id),
                         "path %s is not connected for %s" % (path["id"], selection))
    for wire_id in wires_by_id:
        report.check(wire_id in on_path, "wire %s is on no path" % wire_id)

    # Spec-level checks: step text and the "on paths" column
    raw_wires = {w["id"]: w for w in build_graph.parse_wires(spec_lines)}
    for raw_path in build_graph.parse_paths(spec_lines):
        for step in raw_path["steps"]:
            wire = raw_wires.get(step["wire"])
            report.check(wire is not None and (wire["from"], wire["to"]) == (step["from"], step["to"]),
                         "path %s step %d: text does not match wire %s" % (
                             raw_path["id"], step["n"], step["wire"]))
        numbers = [step["n"] for step in raw_path["steps"]]
        report.check(numbers == list(range(1, len(numbers) + 1)),
                     "path %s: steps are not numbered 1..n" % raw_path["id"])
    for wire_id, wire in raw_wires.items():
        report.check(set(wire["listedPaths"]) == on_path.get(wire_id, set()),
                     "wire %s: 'on paths' column differs from the path listings" % wire_id)

    # Source references
    file_cache = {}

    def source(path):
        if path not in file_cache:
            full = os.path.join(repo, path)
            file_cache[path] = build_graph.read_lines(full) if os.path.exists(full) else None
        return file_cache[path]

    def check_ref(ref, what):
        if ref is None:
            report.check(False, "%s: no reference" % what)
            return
        lines = source(ref["file"])
        report.check(lines is not None, "%s: file %s does not exist" % (what, ref["file"]))
        if lines is None:
            return
        ok = 1 <= ref["line"] <= len(lines) and ref["symbol"] in lines[ref["line"] - 1]
        report.check(ok, "%s: %s:%d does not contain %s" % (what, ref["file"], ref["line"], ref["symbol"]))

    fn_count = set()
    for node in graph["nodes"]:
        for fn in node["fns"]:
            fn_count.add(fn["name"])
            ref = fn["ref"]
            report.check(ref is not None, "function %s: not in Appendix A" % fn["name"])
            if ref:
                lines = source(ref["file"])
                report.check(lines is not None and is_defined_at(lines, ref["line"], fn["name"]),
                             "function %s is not defined at %s:%d" % (fn["name"], ref["file"], ref["line"]))
        for item in node["tunables"]:
            check_ref(item["ref"], "tunable %s" % item["name"])
        for item in node["props"]:
            check_ref(item["ref"], "property %s" % item["name"])
    wire_ref_count = 0
    for wire in graph["wires"]:
        for ref in wire["refs"]:
            wire_ref_count += 1
            check_ref(ref, "wire %s" % wire["id"])
    name_ref_count = len({i["name"] for n in graph["nodes"] for i in n["tunables"] + n["props"]})

    # Counts from section 13
    counts, degrees, path_numbers = expected_counts(spec_lines)
    actual = {
        "nodes": len(graph["nodes"]),
        "wires": len(graph["wires"]),
        "paths": len(graph["paths"]),
        "path steps": sum(len(p["steps"]) for p in graph["paths"]),
        "groups": len(graph["groups"]),
        "wire types": len(graph["types"]),
        "functions in the index": len(fn_count),
        "wire references": wire_ref_count,
        "tunable and property references": name_ref_count,
    }
    report.check(len(counts) == len(actual), "section 13 count line not fully parsed: %s" % counts)
    for label, value in actual.items():
        report.check(counts.get(label) == value,
                     "count of %s is %d, section 13 says %s" % (label, value, counts.get(label)))
    for node_id, n_in, n_out in degrees:
        incoming = len([w for w in graph["wires"] if w["to"] == node_id])
        outgoing = len([w for w in graph["wires"] if w["from"] == node_id])
        if n_in is not None:
            report.check(incoming == n_in, "node %s has %d incoming wires, expected %d" % (node_id, incoming, n_in))
        if n_out is not None:
            report.check(outgoing == n_out, "node %s has %d outgoing wires, expected %d" % (node_id, outgoing, n_out))
    paths_by_id = {p["id"]: p for p in graph["paths"]}
    report.check(len(path_numbers) >= 2, "section 13 path highlight numbers not parsed")
    for path_id, n_wires, n_steps in path_numbers:
        path = paths_by_id[path_id]
        played = played_steps(path, default_selection(path))
        distinct = len({s["wire"] for s in played})
        report.check(distinct == n_wires, "path %s highlights %d wires, expected %d" % (path_id, distinct, n_wires))
        if n_steps is not None:
            report.check(len(played) == n_steps, "path %s plays %d steps, expected %d" % (path_id, len(played), n_steps))

    validate_timelines(graph, report)


def validate_timelines(graph, report):
    """Timeline rules of the suite spec, section 6.4."""
    wires = {w["id"] for w in graph["wires"]}
    paths = {p["id"]: p for p in graph["paths"]}
    for scenario in graph.get("timelines") or []:
        name = "timeline %s" % scenario["id"]
        report.check(len(scenario["steps"]) > 0, "%s: no steps" % name)
        linked = False
        last_txg = -1
        for index, step in enumerate(scenario["steps"], 1):
            where = "%s step %d" % (name, index)
            report.check(step["n"] == index, "%s: numbered %d" % (where, step["n"]))
            report.check(step["txg"] >= last_txg, "%s: txg decreases" % where)
            last_txg = step["txg"]
            if step["path"]:
                linked = True
                report.check(step["path"] in paths, "%s: unknown path %s" % (where, step["path"]))
                if step["path"] in paths and step["pathStep"]:
                    report.check(1 <= step["pathStep"] <= len(paths[step["path"]]["steps"]),
                                 "%s: path step %d out of range" % (where, step["pathStep"]))
            for wire_id in step["wires"]:
                linked = True
                report.check(wire_id in wires, "%s: unknown wire %s" % (where, wire_id))
            names = {d["name"] for d in step["datasets"]}
            for ds in step["datasets"]:
                for field in ("prev", "origin"):
                    if ds[field]:
                        report.check(ds[field] in names, "%s: %s %s=%s is not listed" % (where, ds["name"], field, ds[field]))
            for block in step["blocks"]:
                report.check(block["birth"] <= step["txg"], "%s: block %s born after the step's txg" % (where, block["id"]))
                for ds_name in block["in"] + ([block["dead"]] if block["dead"] else []):
                    report.check(ds_name in names, "%s: block %s names unknown dataset %s" % (where, block["id"], ds_name))
                report.check(block["state"] in ("live", "freed", "deferred", "async"),
                             "%s: block %s has unknown state %s" % (where, block["id"], block["state"]))
                if block["state"] != "live":
                    report.check(not block["in"], "%s: %s block %s is still referenced" % (where, block["state"], block["id"]))
        report.check(linked, "%s: no step links to a path or wires" % name)


def validate_suite(graphs, report):
    """Cross-page checks of the suite spec, section 3."""
    first = {}
    colours = {}
    io_nodes = set()
    for page_id, graph in graphs:
        if page_id == "zfs-io-flow":
            io_nodes = {n["id"] for n in graph["nodes"]}
    for page_id, graph in graphs:
        for node in graph["nodes"]:
            seen = first.setdefault(node["id"], (page_id, node["title"], node["ctx"]))
            report.check((node["title"], node["ctx"]) == seen[1:],
                         "node %s: title/context on %s differ from %s" % (node["id"], page_id, seen[0]))
            if page_id != "zfs-io-flow" and node["id"] in io_nodes:
                report.check(node["role"].startswith("Shared with the I/O flow graph."),
                             "node %s on %s: shared node role does not start with the shared marker" % (node["id"], page_id))
        for wire_type in graph["types"]:
            seen = colours.setdefault(wire_type["id"], (page_id, wire_type["color"].upper()))
            report.check(wire_type["color"].upper() == seen[1],
                         "wire type %s: colour on %s differs from %s" % (wire_type["id"], page_id, seen[0]))

    # `<page id>:<path id>` links in path texts must resolve (suite spec 4.3).
    paths_by_page = {page_id: {p["id"] for p in graph["paths"]} for page_id, graph in graphs}
    for page_id, graph in graphs:
        for path in graph["paths"]:
            for text in (path["summary"], path["ends"]):
                for target_page, target_path in re.findall(r"`([a-z0-9-]+):(\w+)`", text):
                    report.check(target_path in paths_by_page.get(target_page, set()),
                                 "path %s on %s links to missing %s:%s" % (path["id"], page_id, target_page, target_path))


def print_report(report):
    for failure in report.failures:
        print("FAIL:", failure)
    print("%d checks passed, %d failed" % (report.passed, len(report.failures)))


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--graph", default=os.path.join(HERE, "graph.json"))
    parser.add_argument("--spec", default=os.path.join(HERE, "..", "zfs-io-flow-diagram-spec.md"))
    parser.add_argument("--suite", help="validate every page of this manifest (suite.json)")
    parser.add_argument("--out", default=HERE, help="where the suite build wrote its <page>.json files")
    parser.add_argument("--repo", default=os.path.join(HERE, "..", "zfs"))
    args = parser.parse_args()

    if args.suite:
        graphs = []
        failed = 0
        for page in build_graph.load_manifest(args.suite):
            stem = os.path.splitext(page["file"])[0]
            with open(os.path.join(args.out, stem + ".json"), encoding="utf-8") as handle:
                graph = json.load(handle)
            report = Report()
            validate_page(graph, build_graph.read_lines(page["specPath"]), args.repo, report)
            print("%-28s" % page["file"], end=" ")
            print_report(report)
            failed += len(report.failures)
            graphs.append((page["id"], graph))
        report = Report()
        validate_suite(graphs, report)
        print("%-28s" % "cross-page", end=" ")
        print_report(report)
        failed += len(report.failures)
        sys.exit(1 if failed else 0)

    with open(args.graph, encoding="utf-8") as handle:
        graph = json.load(handle)
    report = Report()
    validate_page(graph, build_graph.read_lines(args.spec), args.repo, report)
    print_report(report)
    sys.exit(1 if report.failures else 0)


if __name__ == "__main__":
    main()
